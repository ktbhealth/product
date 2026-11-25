import * as Data from "effect/Data";

import type { EditList, EditOp } from "./schema.ts";

export type { EditList, EditOp };

/**
 * Reversible edit lists — the auditable-diff contract between pipeline
 * stages. The LLM cleanup returns `EditList`, never a rewritten blob:
 * every edit stores the removed text, so a stage transition can be
 * verified (and, with the inverse ops, rolled back).
 *
 * Producers are the generative ports (LlmPort.correct); this module
 * owns APPLICATION. The word-level diff/invert helpers that used to
 * live here (`diffTexts`, `invertEdits`, `revertEdits`,
 * `emptyEditList`) had no callers and were removed — re-add a
 * producer only when a stage actually needs to synthesize an
 * EditList locally.
 */

/** An op claimed to remove text that does not match the base — the
 * edit list is corrupt or targets a different stage's text. Never
 * apply silently. */
export class EditApplyError extends Data.TaggedError("EditApplyError")<{
	readonly at: number;
	readonly expected: string;
	readonly actual: string;
}> {}

const applyOne = (out: string, op: EditOp): string => {
	const actual = out.slice(op.at, op.at + op.remove.length);
	if (actual !== op.remove) {
		throw new EditApplyError({ at: op.at, expected: op.remove, actual });
	}
	return out.slice(0, op.at) + op.insert + out.slice(op.at + op.remove.length);
};

/** Apply ops right-to-left — earlier `at` offsets stay valid. Throws
 * `EditApplyError` when an op's `remove` does not match the base.
 * Ops sharing the same `at` apply in input order — producers
 * must emit non-overlapping ops. */
export const applyEdits = (base: string, ops: readonly EditOp[]): string => {
	let out = base;
	for (const op of [...ops].sort((a, b) => b.at - a.at)) {
		out = applyOne(out, op);
	}
	return out;
};

/** Per-call outcome of `anchorEdits` — how many proposed ops already
 * matched at their offset, how many were moved onto the nearest exact
 * occurrence of their `remove` text, and how many were discarded. */
export interface AnchorStats {
	readonly exact: number;
	readonly reanchored: number;
	readonly dropped: number;
}

/**
 * Normalize a model-proposed edit list against `base` so that
 * `applyEdits` can never throw on it. LLMs reliably quote the text
 * they want to change but almost never count character offsets
 * correctly (local 4–14B models put ~0% of `at` values on the right
 * character), so `remove` is treated as the source of truth and `at`
 * only as a hint:
 *
 * - op matches at its `at` → kept as-is;
 * - otherwise → moved to the occurrence of `remove` nearest to `at`;
 * - `remove` absent from `base`, empty (pure insertion — its position
 *   cannot be verified), or equal to `insert` (no-op) → dropped;
 * - ops overlapping an earlier-kept op → dropped (applyEdits requires
 *   non-overlapping ops).
 *
 * The returned ops are sorted by `at` and carry every other field
 * unchanged. Dropping is lossy by design: an unverifiable edit is
 * never applied.
 */
export const anchorEdits = (
	base: string,
	ops: readonly EditOp[],
): { readonly ops: readonly EditOp[]; readonly stats: AnchorStats } => {
	let exact = 0;
	let reanchored = 0;
	let dropped = 0;
	const placed: EditOp[] = [];
	for (const op of ops) {
		if (op.remove === "" || op.remove === op.insert) {
			dropped++;
			continue;
		}
		if (base.slice(op.at, op.at + op.remove.length) === op.remove) {
			exact++;
			placed.push(op);
			continue;
		}
		let best = -1;
		for (let k = base.indexOf(op.remove); k !== -1; k = base.indexOf(op.remove, k + 1)) {
			if (best === -1 || Math.abs(k - op.at) < Math.abs(best - op.at)) best = k;
		}
		if (best === -1) {
			dropped++;
			continue;
		}
		reanchored++;
		placed.push({ ...op, at: best });
	}
	placed.sort((a, b) => a.at - b.at);
	const kept: EditOp[] = [];
	let end = -1;
	for (const op of placed) {
		if (op.at < end) {
			dropped++;
			continue;
		}
		kept.push(op);
		end = op.at + op.remove.length;
	}
	return { ops: kept, stats: { exact, reanchored, dropped } };
};
