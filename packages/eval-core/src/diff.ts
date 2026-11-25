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
 * occurrence of their `remove` text, how many were discarded as
 * paraphrases (`rewrites`), and how many were discarded for any other
 * reason (`dropped`). */
export interface AnchorStats {
	readonly exact: number;
	readonly reanchored: number;
	readonly rewrites: number;
	readonly dropped: number;
}

export interface AnchorOptions {
	/** Drop ops that rewrite rather than correct (see `isRewrite`).
	 * Default true. */
	readonly rewriteGuard?: boolean;
}

/** Words compared case-insensitively with punctuation stripped, so a
 * punctuation/casing fix costs zero word changes. */
const words = (text: string): string[] =>
	text
		.toLowerCase()
		.split(/\s+/)
		.map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
		.filter((w) => w !== "");

/** Word-level Levenshtein distance. */
const wordDistance = (a: readonly string[], b: readonly string[]): number => {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(
				prev[j]! + 1,
				cur[j - 1]! + 1,
				prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = cur;
	}
	return prev[b.length]!;
};

/** Most words an ASR correction may change regardless of span length
 * — covers a split/merged word ("dorde" → "dor de") plus a neighbour. */
const MAX_FREE_WORD_CHANGES = 2;
/** Above the free allowance, an op may change at most this share of
 * the words in its longer side before it counts as a paraphrase. */
const MAX_CHANGED_WORD_SHARE = 0.5;

/**
 * True when an op paraphrases instead of correcting. ASR fixes touch
 * one or two words ("exajurai" → "exagerei", "dorde" → "dor de");
 * small chat models also emit whole-sentence rewrites ("Fume não,
 * nunca fumei, graças a Deus." → "Não fumo, nunca fumei.") that
 * change what was said and inflate WER. An op is a rewrite when it
 * changes more than MAX_FREE_WORD_CHANGES words AND more than
 * MAX_CHANGED_WORD_SHARE of the words on its longer side.
 */
export const isRewrite = (op: Pick<EditOp, "remove" | "insert">): boolean => {
	const before = words(op.remove);
	const after = words(op.insert);
	const changed = wordDistance(before, after);
	return (
		changed > MAX_FREE_WORD_CHANGES &&
		changed / Math.max(before.length, after.length) > MAX_CHANGED_WORD_SHARE
	);
};

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
 *   non-overlapping ops);
 * - paraphrases (`isRewrite`) → dropped unless `rewriteGuard: false`.
 *
 * The returned ops are sorted by `at` and carry every other field
 * unchanged. Dropping is lossy by design: an unverifiable edit is
 * never applied.
 */
export const anchorEdits = (
	base: string,
	ops: readonly EditOp[],
	options: AnchorOptions = {},
): { readonly ops: readonly EditOp[]; readonly stats: AnchorStats } => {
	const rewriteGuard = options.rewriteGuard ?? true;
	let exact = 0;
	let reanchored = 0;
	let rewrites = 0;
	let dropped = 0;
	const placed: EditOp[] = [];
	for (const op of ops) {
		if (op.remove === "" || op.remove === op.insert) {
			dropped++;
			continue;
		}
		if (rewriteGuard && isRewrite(op)) {
			rewrites++;
			continue;
		}
		// `at` is only Schema.Number — a negative offset would slice()
		// from the end and "match" text at a mirrored position.
		if (op.at >= 0 && base.slice(op.at, op.at + op.remove.length) === op.remove) {
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
	return { ops: kept, stats: { exact, reanchored, rewrites, dropped } };
};
