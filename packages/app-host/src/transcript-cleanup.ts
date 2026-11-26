import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestratorRegistry } from "@ktb/orchestrator";
import { PipelineRegistry } from "@ktb/pipeline";
import { ENV_CORRECTOR_KEY, type EnvCorrector } from "@ktb/plugin-pipeline-transcript";
import { transcriptOrchestrationConfig } from "@ktb/plugin-pipeline-transcript/orchestration";

/**
 * transcript-cleanup.ts — the `consultation-transcript` run both
 * registries can serve, extracted from `createApp`'s `correctTranscript`
 * so the orchestrator-first/pipeline-fallback probe order is unit
 * testable without composing a whole app.
 *
 * CUTOVER ORDER (P-120): `OrchestratorRegistry` wins when it is bound
 * AND knows `consultation-transcript` (the pipeline.transcript
 * manifest contributes the OrchestrationDef twin via `orchestrations`,
 * collected by `orchestratorRegistryLive` in the core layer). The env
 * corrector rides `RunOptions.config` — a FUNCTION, which survives the
 * in-memory runner but NOT the durable runner's serialized snapshots
 * (see orchestration.ts's KNOWN GAPS: durable runs need a port-based
 * corrector). `correctTranscript` is per-request and in-memory, so the
 * cast is safe here.
 *
 * `PipelineRegistry` is the transition fallback: consulted only when
 * the orchestrator service is absent or lacks the def — never after a
 * successful orchestrator run, even one that produced disabled state
 * (the stages are shared, so a second engine would only repeat the
 * same probes). An orchestrator RUN failure also returns null rather
 * than retrying on the pipeline — the failure is logged and the
 * caller stores null, same never-reject contract as before.
 */

/** The pipeline/orchestration id both engines register under. */
const TRANSCRIPT_CLEANUP_ID = "consultation-transcript";

export interface CorrectedTranscript {
	readonly corrected: string;
	readonly engine: string;
}

interface TranscriptInput {
	readonly text: string;
	readonly segments?: readonly { readonly text: string }[];
}

/** `state.cleanup` → the public contract. Both engines produce the
 * identical fragment (the orchestration kinds return the stage's
 * StageResult.state verbatim), so one extractor serves both. The
 * `pipeline:` engine prefix is part of the return contract — kept for
 * both engines since they run the same stages. */
const cleanupOutcome = (state: Readonly<Record<string, unknown>>): CorrectedTranscript | null => {
	const cleanup = state.cleanup as
		| {
				readonly enabled?: unknown;
				readonly corrected?: unknown;
				readonly engine?: unknown;
		  }
		| undefined;
	if (
		cleanup?.enabled !== true ||
		typeof cleanup.corrected !== "string" ||
		typeof cleanup.engine !== "string"
	) {
		return null;
	}
	// Same contract as the legacy paths: trimmed text, and an
	// empty correction is no correction.
	const corrected = cleanup.corrected.trim();
	return corrected === "" ? null : { corrected, engine: `pipeline:${cleanup.engine}` };
};

/** Probe OrchestratorRegistry first, PipelineRegistry second, extract
 * `state.cleanup` identically from either. Never fails typed — run
 * errors and defects log and yield null, matching the pack's
 * degrade-to-disabled contract (the pipeline never rejects either). */
export const correctTranscriptEffect = (
	input: TranscriptInput,
	envCorrect: EnvCorrector,
): Effect.Effect<CorrectedTranscript | null> =>
	Effect.gen(function* () {
		if (input.text.trim() === "") return null;
		const wire = {
			text: input.text,
			...(input.segments !== undefined ? { segments: input.segments } : {}),
		};

		const orchestratorOpt = yield* Effect.serviceOption(OrchestratorRegistry);
		if (Option.isSome(orchestratorOpt) && orchestratorOpt.value.has(TRANSCRIPT_CLEANUP_ID)) {
			const result = yield* orchestratorOpt.value
				.run(TRANSCRIPT_CLEANUP_ID, wire, {
					config: transcriptOrchestrationConfig(envCorrect),
				})
				.pipe(
					Effect.catch((error) =>
						Effect.logWarning("transcript orchestration failed", {
							error: String(error),
						}).pipe(Effect.as(null)),
					),
					Effect.catchDefect((defect) =>
						Effect.logWarning("transcript orchestration failed", {
							error: String(defect),
						}).pipe(Effect.as(null)),
					),
				);
			return result === null ? null : cleanupOutcome(result.state);
		}

		const registryOpt = yield* Effect.serviceOption(PipelineRegistry);
		if (Option.isNone(registryOpt)) return null;
		const registry = registryOpt.value;
		if (!registry.has(TRANSCRIPT_CLEANUP_ID)) return null;
		const result = yield* registry
			.run(TRANSCRIPT_CLEANUP_ID, wire, { [ENV_CORRECTOR_KEY]: envCorrect })
			.pipe(
				Effect.catch((error) =>
					Effect.logWarning("transcript pipeline failed", {
						error: String(error),
					}).pipe(Effect.as(null)),
				),
				Effect.catchDefect((defect) =>
					Effect.logWarning("transcript pipeline failed", {
						error: String(defect),
					}).pipe(Effect.as(null)),
				),
			);
		return result === null ? null : cleanupOutcome(result.state);
	});
