import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Anamnesis, ExtractInput } from "@ktb/anamnesis";
import { anamnesisWithHistory, HeuristicExtractor } from "@ktb/anamnesis";
import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { decodeAnamnesis } from "@ktb/anamnesis/schema";
import { LlmPort, preferringLlmPortLive } from "@ktb/eval-core";
import { buildPrompt } from "./prompt.ts";
import { envLlmPort } from "./llm-port.ts";
import type { LlmConfig } from "./llm.ts";

export type { LlmConfig } from "./llm.ts";

// Port tags live in the domain package (@ktb/anamnesis/services); this
// module only provides the Live layers — impl → port direction.

const heuristicExtract = (transcript: string): Effect.Effect<Anamnesis> =>
	Effect.promise(() => new HeuristicExtractor().extract(transcript));

/** `generate` returns bare JSON per the anamnesis prompt — tolerate a
 * markdown fence or surrounding prose anyway (local models wrap output
 * unpredictably), then validate against AnamnesisSchema. */
export const parseAnamnesis = (text: string): Anamnesis => {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
	const body = fenced?.[1] ?? trimmed;
	try {
		return decodeAnamnesis(JSON.parse(body));
	} catch {
		// Prose around the payload — slice the outermost object.
		const start = body.indexOf("{");
		const end = body.lastIndexOf("}");
		if (start === -1 || end <= start) throw new Error("no JSON object in model output");
		return decodeAnamnesis(JSON.parse(body.slice(start, end + 1)));
	}
};

/** Failure tag: a named provider reports `<engine>!fallback`; the
 * unconfigured (`heuristic`) engine IS the fallback, so it keeps its
 * plain tag. */
const fallbackEngine = (engineName: string): string =>
	engineName === "heuristic" ? "heuristic" : `${engineName}!fallback`;

/**
 * Engine backed by the canonical {@link LlmPort} — the single
 * generative port. `engineName` is the fallback identity tag (the
 * success tag comes from the serving endpoint's RunRecord, so a
 * platform-default endpoint reports `platform:<engine>`). LLM failure
 * degrades to the deterministic heuristic extractor.
 */
export const makeAnamnesisEngine = (
	engineName: string,
): Layer.Layer<AnamnesisEngine, never, LlmPort> =>
	Layer.effect(
		AnamnesisEngine,
		Effect.gen(function* () {
			const llm = yield* LlmPort;
			const fallback = (input: ExtractInput, error: unknown) =>
				Effect.logWarning("anamnesis extraction failed, using heuristic", {
					engine: engineName,
					error: String(error),
				}).pipe(
					Effect.andThen(heuristicExtract(input.transcript)),
					Effect.map((anamnesis) => ({
						anamnesis: anamnesisWithHistory(anamnesis, input.history),
						engine: fallbackEngine(engineName),
					})),
				);
			return AnamnesisEngine.of({
				extract: Effect.fn("AnamnesisEngine.extract")((input: ExtractInput) =>
					Effect.gen(function* () {
						const res = yield* llm.generate({
							taskId: "anamnesis-extract",
							role: "generator",
							input: `${buildPrompt(input.history, input.patient)}${input.transcript}`,
							outputSchema: "Text",
						});
						const anamnesis = yield* Effect.try({
							try: () => parseAnamnesis(res.text),
							catch: (e) => e,
						});
						return {
							anamnesis: anamnesisWithHistory(anamnesis, input.history),
							engine: res.record.engine,
						};
					}).pipe(
						// Transport-boundary span: attributes are the bounded
						// engine tag, never transcript/patient content.
						Effect.withSpan("anamnesis.llm", {
							attributes: { "anamnesis.engine": engineName },
						}),
						Effect.catch((error) => fallback(input, error)),
						Effect.catchDefect((defect) => fallback(input, defect)),
					),
				),
			});
		}),
	);

/** Deterministic-only engine — no LLM endpoint at all (not even a
 * platform default can reach it: this layer never touches LlmPort). */
export const heuristicAnamnesisEngineLive: Layer.Layer<AnamnesisEngine> = Layer.succeed(
	AnamnesisEngine,
	AnamnesisEngine.of({
		extract: Effect.fn("AnamnesisEngine.extract")((input: ExtractInput) =>
			heuristicExtract(input.transcript).pipe(
				Effect.map((anamnesis) => ({
					anamnesis: anamnesisWithHistory(anamnesis, input.history),
					engine: "heuristic",
				})),
			),
		),
	}),
);

/**
 * AnamnesisEngine over a chosen LlmPort layer, routed through
 * `preferringLlmPortLive` so the ai-provider plugin's platform-default
 * endpoint wins over `port` per call (the dissolved platform-llm
 * bridge — the precedence now lives inside the port itself). `port`
 * omitted → platform-or-nothing resolution (null fallback). */
export const anamnesisEngineFor = (
	engineName: string,
	port?: Layer.Layer<LlmPort>,
): Layer.Layer<AnamnesisEngine> =>
	makeAnamnesisEngine(engineName).pipe(Layer.provide(preferringLlmPortLive(port)));

/**
 * Self-contained engine layer chosen from injected config — the
 * composition root supplies env-derived values; no process.env here.
 * The env provider (when configured) is the LlmPort fallback; the
 * platform-default endpoint still wins per call via
 * `preferringLlmPortLive`, exactly like the driver-selected path.
 */
export const AnamnesisEngineLive = (cfg: LlmConfig): Layer.Layer<AnamnesisEngine> => {
	const env = envLlmPort(cfg);
	return anamnesisEngineFor(env?.engine ?? "heuristic", env?.layer);
};
