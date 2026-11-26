import type { EditOp } from "@ktb/eval-core";

/**
 * Timestamped corrector input (T-207) — optionally render ASR
 * segments as `[m:ss] text` lines so the corrector sees WHERE in the
 * consult each phrase sits. The EditList contract is unchanged: ops
 * come back quoting `remove` text, and `at` offsets index into
 * whatever string the model saw — the timestamped rendering, NOT the
 * stored transcript.
 *
 * Sanitization is what makes the mode safe: timestamp tokens are
 * stripped from `remove`/`insert`, whitespace is collapsed, and the
 * surviving ops are re-anchored onto the plain transcript
 * (`anchorEdits` in pipeline.ts) — an op that only touched a
 * timestamp, or whose quoted span no longer exists without the
 * markers, drops instead of corrupting the corrected text. A medical
 * transcript legitimately contains clock times ("às 14:30"); only the
 * bracketed `[m:ss]` shape this module injects is treated as a
 * timestamp token, and only in timestamps mode.
 */

/** `[m:ss]`, `[h:mm:ss]`, optional `.fff` — the shape
 * timestampedCorrectorInput emits. */
const TIMESTAMP_TOKEN = /\[\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?\]/g;

const mmss = (sec: number): string =>
	`${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/** Render segments as `[m:ss] text` lines — the corrector's input
 * when timestamps mode is on. */
export const timestampedCorrectorInput = (
	segments: readonly { readonly t0: number; readonly text: string }[],
): string => segments.map((s) => `[${mmss(s.t0)}] ${s.text.trim()}`).join("\n");

/** Strip timestamp tokens, collapse whitespace runs, trim — the
 * normal form an op's `remove`/`insert` must have before it can
 * anchor onto the plain transcript. */
const cleanSpan = (text: string): string =>
	text.replace(TIMESTAMP_TOKEN, "").replace(/\s+/g, " ").trim();

/** Sanitize model ops produced against timestamped input: timestamp
 * artifacts never reach `applyEdits` or the corrected text. Ops are
 * NOT re-anchored here — the caller runs `anchorEdits` against the
 * plain transcript so unverifiable spans drop by the usual contract. */
export const sanitizeTimestampOps = (ops: readonly EditOp[]): EditOp[] =>
	ops.map((op) => ({
		...op,
		remove: cleanSpan(op.remove),
		insert: cleanSpan(op.insert),
	}));
