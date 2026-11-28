import * as Effect from "effect/Effect";

import { LlmPort } from "@ktb/eval-core";

import { envLlmPort } from "./llm-port.ts";
import type { LlmConfig } from "./llm.ts";

export interface CorrectedTranscript {
	readonly corrected: string;
	/** Provider tag, mirroring the anamnesis engine names. */
	readonly engine: string;
}

/**
 * Prompt contract (P-017): surface correction only — fix ASR errors,
 * punctuation and speaker-flow artifacts. Never summarize, reorder, or
 * invent clinical content; clinical terms stay verbatim; PT-BR output.
 * Delivered through the env LlmPort's `generate` — the TaskEnvelope is
 * text-in/text-out, so the system contract is inlined ahead of the
 * transcript (same single-input shape the platform path uses).
 */
export const CLEANUP_SYSTEM_PROMPT = `You are a transcription post-processor for Brazilian Portuguese (PT-BR) clinical consultations.

Fix only speech-recognition artifacts: punctuation, capitalization, obvious misrecognized words, and speaker-flow artifacts.

Rules:
- Output ONLY the corrected transcript text — no commentary, no labels, no JSON.
- Preserve clinical terms, drug names, dosages and proper nouns verbatim.
- Never summarize, reorder, add or remove clinical content.
- Keep the original language (PT-BR); do not translate.
- If the transcript is already clean, return it unchanged.`;

/**
 * LLM transcript cleanup (P-017): produces a corrected PT-BR transcript
 * alongside the raw server transcript through the env-derived
 * {@link LlmPort} — provider precedence mirrors AnamnesisEngineLive
 * (anthropic > openai > workers-ai). This is the ENV corrector only:
 * platform-endpoint correction is the pipeline's llm-cleanup stage,
 * a separate port contract — callers never chain providers outside
 * the def. Never fails — returns null when unconfigured, empty input,
 * or on any provider error, so callers keep correctedTranscript null
 * and the status stays "done".
 */
export const correctTranscript = (
	cfg: LlmConfig,
	transcript: string,
): Effect.Effect<CorrectedTranscript | null> => {
	const trimmed = transcript.trim();
	if (!trimmed) return Effect.succeed(null);
	const env = envLlmPort(cfg);
	if (env === null) return Effect.succeed(null);
	return Effect.gen(function* () {
		const llm = yield* LlmPort;
		const res = yield* llm.generate({
			taskId: "transcript-cleanup",
			role: "generator",
			input: `${CLEANUP_SYSTEM_PROMPT}\n\nTRANSCRIPT:\n${trimmed}`,
			outputSchema: "Text",
		});
		const corrected = res.text.trim();
		return corrected ? { corrected, engine: res.record.engine } : null;
	}).pipe(
		// Transport-boundary span: the engine tag is a bounded provider
		// name, never transcript content.
		Effect.withSpan("transcript.cleanup", {
			attributes: { "transcript.engine": env.engine },
		}),
		Effect.provide(env.layer),
		Effect.catch((error) =>
			Effect.logWarning("transcript cleanup failed", {
				engine: env.engine,
				error: String(error),
			}).pipe(Effect.as(null)),
		),
		Effect.catchDefect((defect) =>
			Effect.logWarning("transcript cleanup failed", {
				engine: env.engine,
				error: String(defect),
			}).pipe(Effect.as(null)),
		),
	);
};
