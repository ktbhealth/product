import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LanguageModel, Prompt } from "effect/ai";

import { fnvHex, LlmPort, PortError, type RunRecord, type TaskEnvelope } from "@ktb/eval-core";

import { anthropicLanguageModelLive, openAiLanguageModelLive, type LlmConfig } from "./llm.ts";
import { DEFAULT_WORKERS_AI_MODEL, runChat, type WorkersAiBinding } from "./workers-ai.ts";

/**
 * llm-port.ts — env-derived LlmPort implementations (the BYOK side of
 * the unified generative port).
 *
 * effect/ai `LanguageModel` is an implementation detail living UNDER
 * LlmPort here: the composition root resolves `LlmConfig` (env/secrets)
 * once and these factories adapt each provider to the canonical port
 * contract — `generate` returns `{text, record}`, `correct` is an
 * honest PortError because the env path never offered surface
 * correction (the pipeline's corrector is a separate port contract).
 *
 * Consumers route through `preferringLlmPortLive` (@ktb/eval-core) so
 * the ai-provider plugin's platform-default endpoint wins when
 * configured; these layers are the (b) env fallback.
 */

const causeMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

/** Every env-backed generate reports through the same RunRecord
 * shape the eval adapters emit — `engine` is the provider tag the
 * anamnesis engine surfaces (`anthropic`, `openai`,
 * `workers-ai:<model>`). */
const envRecord = (
	engine: string,
	model: string | undefined,
	envelope: TaskEnvelope,
	started: number,
): RunRecord => ({
	runId: "env",
	taskId: envelope.taskId,
	stage: "generate",
	engine,
	...(model !== undefined ? { model } : {}),
	inputHash: fnvHex(
		`${envelope.taskId}:${envelope.outputSchema}:${envelope.input}:${envelope.seed ?? 0}`,
	),
	...(envelope.seed !== undefined ? { seed: envelope.seed } : {}),
	startedAt: started,
	latencyMs: Date.now() - started,
});

/** Env providers have no corrector — fail honestly instead of
 * improvising an EditList the caller never asked this path for. */
const unsupportedCorrect = (engine: string) => (): Effect.Effect<never, PortError> =>
	Effect.fail(
		new PortError({
			port: "llm",
			message: `${engine} env endpoint does not support correct()`,
		}),
	);

/** LlmPort over an effect/ai `LanguageModel` (Anthropic / OpenAI
 * providers). The envelope's `input` is sent as a single user
 * message — the TaskEnvelope contract is text-in/text-out, so callers
 * inline any system instructions into `input` (the anamnesis prompt
 * already does). */
export const makeLanguageModelLlmPort = (
	engine: string,
	model: string | undefined,
	languageModel: Layer.Layer<LanguageModel.LanguageModel>,
): Layer.Layer<LlmPort> =>
	Layer.unwrap(
		Effect.map(
			Effect.service(LanguageModel.LanguageModel).pipe(Effect.provide(languageModel)),
			(lm) =>
				Layer.succeed(
					LlmPort,
					LlmPort.of({
						egress: true,
						generate: (envelope) => {
							const started = Date.now();
							return lm
								.generateText({
									prompt: [
										Prompt.userMessage({
											content: [Prompt.textPart({ text: envelope.input })],
										}),
									],
								})
								.pipe(
									Effect.mapError(
										(e) =>
											new PortError({
												port: "llm",
												message: `${engine}: ${causeMessage(e)}`,
												cause: e,
											}),
									),
									Effect.map((response) => ({
										text: response.text,
										record: envRecord(engine, model, envelope, started),
									})),
								);
						},
						correct: unsupportedCorrect(engine),
					}),
				),
		),
	);

/** LlmPort over the Workers AI binding (`env.AI` / local
 * OpenAI-compatible shim) — chat-completions shape via `runChat`. */
export const makeWorkersAiLlmPort = (ai: WorkersAiBinding, model: string): Layer.Layer<LlmPort> => {
	const engine = `workers-ai:${model}`;
	return Layer.succeed(
		LlmPort,
		LlmPort.of({
			egress: true,
			generate: (envelope) => {
				const started = Date.now();
				// No system message — the TaskEnvelope input already
				// carries the full prompt (see makeLanguageModelLlmPort).
				return runChat(ai, model, "", envelope.input).pipe(
					Effect.mapError(
						(e) =>
							new PortError({
								port: "llm",
								message: `${engine}: ${causeMessage(e)}`,
								cause: e,
							}),
					),
					Effect.map((text) => ({
						text,
						record: envRecord(engine, model, envelope, started),
					})),
				);
			},
			correct: unsupportedCorrect(engine),
		}),
	);
};

/** Resolve the env-derived LlmPort for a composition-root `LlmConfig` —
 * provider precedence mirrors the historical AnamnesisEngineLive
 * selection (anthropic > openai > workers-ai). `null` = no generative
 * env provider configured; callers pair the result with
 * `preferringLlmPortLive` so the platform default can still serve. */
export const envLlmPort = (
	cfg: LlmConfig,
): { readonly layer: Layer.Layer<LlmPort>; readonly engine: string } | null => {
	if (cfg.anthropicApiKey) {
		const model = cfg.anthropicModel ?? "claude-haiku-4-5";
		return {
			engine: "anthropic",
			layer: makeLanguageModelLlmPort(
				"anthropic",
				model,
				anthropicLanguageModelLive({ apiKey: cfg.anthropicApiKey, model }),
			),
		};
	}
	if (cfg.openAiApiKey) {
		const model = cfg.openAiModel ?? "gpt-4o-mini";
		return {
			engine: "openai",
			layer: makeLanguageModelLlmPort(
				"openai",
				model,
				openAiLanguageModelLive({
					apiKey: cfg.openAiApiKey,
					baseUrl: cfg.openAiBaseUrl,
					model,
				}),
			),
		};
	}
	if (cfg.workersAi) {
		const model = cfg.workersAiModel ?? DEFAULT_WORKERS_AI_MODEL;
		return {
			engine: `workers-ai:${model}`,
			layer: makeWorkersAiLlmPort(cfg.workersAi, model),
		};
	}
	return null;
};
