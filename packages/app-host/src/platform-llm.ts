/**
 * platform-llm.ts — F2: production LLM surfaces resolve the
 * ai-endpoints plugin's `PlatformLlm` capability BEFORE the env-derived
 * `LlmConfig` providers.
 *
 * Resolution order (per call — admin edits apply without a restart):
 *   a) enabled `scope='platform'` `is_default` endpoint → descriptor +
 *      apiKey → `LlmFactory` layer (bound by the plugin's services);
 *   b) env fallback — the caller's existing `LlmConfig` path
 *      (ANTHROPIC_API_KEY / LLM_* / Workers AI);
 *   c) the deterministic/null fallback each caller already owns.
 *
 * The port is a plugin capability, never a hard dep: app-host can't
 * import plugins, so it reads the tag through `Effect.serviceOption`
 * — an absent plugin resolves to `null` exactly like an unconfigured
 * default.
 */

import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { anamnesisWithHistory, type Anamnesis, type ExtractInput } from "@ktb/anamnesis";
import { decodeAnamnesis } from "@ktb/anamnesis/schema";
import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { buildPrompt, CLEANUP_SYSTEM_PROMPT, type CorrectedTranscript } from "@ktb/anamnesis-llm";
import { LlmPort, PlatformLlm } from "@ktb/eval-consultation";

/** `Layer<LlmPort>` for the platform-default endpoint — null when the
 * port is unbound, no default exists, or resolution failed. Errors
 * degrade to null: a broken platform endpoint must not take the
 * env-configured fallback down with it. */
const platformLayer: Effect.Effect<Layer.Layer<LlmPort> | null> = Effect.gen(function* () {
	const platform = yield* Effect.serviceOption(PlatformLlm);
	if (Option.isNone(platform)) return null;
	// `defaultLayer` declares R=unknown because the plugin impl may read
	// credentials; those are bound in the app context by composition, so
	// the never-R view is sound here (and tests stub PlatformLlm anyway).
	return yield* (platform.value.defaultLayer() as Effect.Effect<Layer.Layer<LlmPort> | null>).pipe(
		Effect.catch(() => Effect.succeed(null)),
		// Defects (e.g. the ai_endpoint table absent from a partial test
		// database) must also degrade to "no platform endpoint".
		Effect.catchDefect(() => Effect.succeed(null)),
	);
});

/** Transcript cleanup through the platform-default endpoint —
 * `generate` (not `correct`, which is ACP/EditList-only) so both acp
 * and openai-compat endpoints serve it. The system prompt rides in
 * the envelope input since the contract is a single text field. */
export const correctTranscriptViaPlatform = (
	transcript: string,
): Effect.Effect<CorrectedTranscript | null> =>
	Effect.gen(function* () {
		const layer = yield* platformLayer;
		if (layer === null) return null;
		const res = yield* LlmPort.pipe(
			Effect.flatMap((llm) =>
				llm.generate({
					taskId: "transcript-cleanup",
					role: "corrector",
					input: `${CLEANUP_SYSTEM_PROMPT}\n\n${transcript}`,
					outputSchema: "Text",
				}),
			),
			Effect.provide(layer),
			Effect.catch((error) =>
				Effect.logWarning("platform transcript cleanup failed", {
					error: String(error),
				}).pipe(Effect.as(null)),
			),
			Effect.catchDefect((defect) =>
				Effect.logWarning("platform transcript cleanup failed", {
					error: String(defect),
				}).pipe(Effect.as(null)),
			),
		);
		if (res === null) return null;
		const corrected = res.text.trim();
		return corrected === "" ? null : { corrected, engine: `platform:${res.record.engine}` };
	});

/** `generate` returns bare JSON per the anamnesis prompt — tolerate a
 * markdown fence anyway, then validate against AnamnesisSchema. */
const parseAnamnesis = (text: string): Anamnesis => {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
	return decodeAnamnesis(JSON.parse(fenced?.[1] ?? trimmed));
};

const extractViaLlmPort = (layer: Layer.Layer<LlmPort>, input: ExtractInput) =>
	Effect.gen(function* () {
		const llm = yield* LlmPort;
		const res = yield* llm.generate({
			taskId: "anamnesis-extract",
			role: "generator",
			input: `${buildPrompt(input.history, input.patient)}${input.transcript}`,
			outputSchema: "Text",
		});
		const anamnesis = yield* Effect.try(() => parseAnamnesis(res.text));
		return {
			anamnesis: anamnesisWithHistory(anamnesis, input.history),
			engine: `platform:${res.record.engine}`,
		};
	}).pipe(Effect.provide(layer));

/**
 * Wraps the env-selected engine: platform default first, the wrapped
 * engine (env provider or heuristic) on absence/failure. Bound once at
 * composition — the wrapper only redirects `extract` calls.
 */
export const platformPreferringEngine = (
	inner: AnamnesisEngine["Service"],
): AnamnesisEngine["Service"] =>
	AnamnesisEngine.of({
		extract: Effect.fn("AnamnesisEngine.extract")(function* (input: ExtractInput) {
			const layer = yield* platformLayer;
			if (layer !== null) {
				const res = yield* extractViaLlmPort(layer, input).pipe(
					Effect.catch((error) =>
						Effect.logWarning("platform anamnesis extraction failed, using env fallback", {
							error: String(error),
						}).pipe(Effect.as(null)),
					),
					Effect.catchDefect((defect) =>
						Effect.logWarning("platform anamnesis extraction failed, using env fallback", {
							error: String(defect),
						}).pipe(Effect.as(null)),
					),
				);
				if (res !== null) return res;
			}
			return yield* inner.extract(input);
		}),
	});
