import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import {
	anchorEdits,
	applyEdits,
	EditApplyError,
	fnvHex,
	LlmPort,
	PortError,
	type EditOp,
	type PromptRef,
	type RunRecord,
} from "@ktb/eval-core";

import type { AsrRange } from "./asr-ranges.ts";
import { sanitizeTimestampOps, timestampedCorrectorInput } from "./cleanup-timestamps.ts";

/**
 * Transcript-cleanup chain — the LlmPort.correct orchestration shared
 * by the eval pipeline (evals/consultation) and production surfaces
 * (plugins/pipeline-transcript). Extracted from the eval domain pack
 * so production code never imports `@ktb/eval-consultation`: the port
 * contracts live in `@ktb/eval-core`, the ASR-range detection in
 * ./asr-ranges.ts, and this module owns the corrector calls, the
 * reversible-edit contract and the declared prompt identity.
 */

// ---------- LLM cleanup → reversible edits → corrected text ----------

export const cleanupTranscript = (input: {
	readonly taskId: string;
	readonly raw: string;
	/** ASR segments — when non-empty, the corrector sees them rendered
	 * as `[m:ss] text` lines (temporal context for localizing errors)
	 * instead of the flat transcript. Returned ops index into the
	 * TIMESTAMPED text, so they are sanitized (timestamp tokens
	 * stripped) and re-anchored onto `raw` before application —
	 * timestamp artifacts can never reach the corrected text, and the
	 * recorded EditList always spans `raw` (T-207). */
	readonly timestamps?: readonly { readonly t0: number; readonly text: string }[];
	/** Invoked with the corrector's RunRecord the moment `correct`
	 * returns — BEFORE edit application — so a corrupt-edit-list
	 * failure still leaves the completed call's audit record. Fires
	 * once per attempt when a corrupt edit list triggers the retry. */
	readonly onRecord?: (record: RunRecord) => void;
}) =>
	Effect.gen(function* () {
		const llm = yield* LlmPort;
		const tsMode = input.timestamps !== undefined && input.timestamps.length > 0;
		const correctorInput = tsMode ? timestampedCorrectorInput(input.timestamps!) : input.raw;
		// One retry on a corrupt edit list: ops that parse but do not
		// apply (wrong text, garbage offsets from an unanchored
		// adapter) get a second correct() call — the model is
		// stochastic, a fresh attempt often produces applicable ops.
		// LlmPort failures (port "llm") are NOT retried here — the
		// batch-level transient retry owns those. Both attempts leave
		// their RunRecord via onRecord.
		const attempt = Effect.gen(function* () {
			const { edits, record } = yield* llm.correct({
				taskId: input.taskId,
				role: "corrector",
				input: correctorInput,
				outputSchema: "EditList",
			});
			// Stamp the pack's declared corrector-prompt identity at the
			// source — every caller (processSample AND the EvalRunner
			// driver path) gets it; an adapter-stamped `prompt` always
			// wins (withStagePrompt never overwrites).
			const stamped = withStagePrompt(CLEANUP_PROMPT)(record);
			input.onRecord?.(stamped);
			// Timestamps mode: ops were authored against the [m:ss]
			// rendering — sanitize timestamp tokens out of remove/
			// insert, then anchor onto the plain transcript. Anchored
			// ops cannot fail applyEdits; unverifiable spans (ops that
			// only touched a timestamp, quotes that no longer exist
			// without the markers) drop by the usual contract.
			const ops = tsMode ? anchorEdits(input.raw, sanitizeTimestampOps(edits.ops)).ops : edits.ops;
			// Corrupt edit lists are an expected adapter failure (LLMs emit
			// garbage offsets) — typed failure, never a silent fiber defect.
			const corrected = yield* Effect.try({
				try: () => applyEdits(input.raw, ops),
				catch: (cause) =>
					new PortError({
						port: "pipeline",
						message:
							cause instanceof EditApplyError
								? `corrupt edit list at ${cause.at}: expected "${cause.expected}", got "${cause.actual}"`
								: /* v8 ignore next -- applyEdits only throws EditApplyError */ "corrupt edit list",
						cause,
					}),
			});
			return { edits: { ops }, corrected, record: stamped };
		});
		return yield* attempt.pipe(
			Effect.retry({
				while: (e) => e instanceof PortError && e.port === "pipeline",
				schedule: Schedule.once,
			}),
		);
	});

/**
 * Gated variant of `cleanupTranscript` — the corrector sees ONLY the
 * char spans a CleanupGate flagged, one `correct` call per span, and
 * the returned edits are shifted back to full-transcript offsets.
 * Model ops are re-anchored against each span's slice (adapters that
 * anchor make this idempotent; ones that trust `at` get the same
 * tolerance), so an edit can never land outside its flagged span —
 * the "edits outside a range are discarded" rule holds by
 * construction. `ranges` MUST be sorted and non-overlapping
 * (charRangesFor guarantees both) so the shifted ops stay disjoint —
 * applyEdits requires non-overlapping ops. An empty `ranges` runs no
 * calls and yields the raw text with an empty edit list.
 */
export const cleanupTranscriptGated = (input: {
	readonly taskId: string;
	readonly raw: string;
	readonly ranges: readonly AsrRange[];
	readonly onRecord?: (record: RunRecord) => void;
}) =>
	Effect.gen(function* () {
		const llm = yield* LlmPort;
		const ops: EditOp[] = [];
		for (const [i, range] of input.ranges.entries()) {
			const slice = input.raw.slice(range.start, range.end);
			const { edits, record } = yield* llm.correct({
				taskId: `${input.taskId}-r${i}`,
				role: "corrector",
				input: slice,
				outputSchema: "EditList",
			});
			input.onRecord?.(withStagePrompt(CLEANUP_PROMPT)(record));
			// Anchor against the SLICE — the model counted offsets into
			// the only text it saw. Ops it cannot verify there (pure
			// insertions, quoted text absent from the span, paraphrases)
			// drop before the offset shift, never in full-text coords.
			const { ops: anchored } = anchorEdits(slice, edits.ops);
			for (const op of anchored) {
				ops.push({ ...op, at: op.at + range.start });
			}
		}
		// Same corrupt-edit-list contract as cleanupTranscript — kept
		// as a typed failure even though anchored+disjoint ops cannot
		// throw by construction.
		const corrected = yield* Effect.try({
			try: () => applyEdits(input.raw, ops),
			catch: /* v8 ignore next -- anchored+disjoint ops never throw */ (cause) =>
				new PortError({
					port: "pipeline",
					message:
						cause instanceof EditApplyError
							? `corrupt edit list at ${cause.at}: expected "${cause.expected}", got "${cause.actual}"`
							: "corrupt edit list",
					cause,
				}),
		});
		return { edits: { ops }, corrected };
	});

// ---------- prompt identities (T-135) ----------

/** Fill `prompt` on a stage record when the adapter did not declare
 * one — the pack's declared contract identity, never overwriting a
 * richer adapter-stamped ref. */
export const withStagePrompt =
	(prompt: PromptRef) =>
	(r: RunRecord): RunRecord =>
		r.prompt === undefined ? { ...r, prompt } : r;

/** Cleanup corrector prompt identity. The corrector prompt TEXT is
 * adapter-owned (each LlmPort.correct implementation builds its own);
 * the pack owns the envelope contract — role "corrector" +
 * outputSchema "EditList" — so the hash pins exactly that contract,
 * nothing more. The `name` keeps its historical
 * `eval.consultation/…` spelling: prompt identities are persisted on
 * RunRecords and compared across runs, so the string must not drift
 * even though the code now lives in @ktb/transcript-cleanup. */
export const CLEANUP_PROMPT: PromptRef = {
	name: "eval.consultation/cleanup-corrector",
	version: 1,
	hash: fnvHex(JSON.stringify({ role: "corrector", outputSchema: "EditList" })),
};
