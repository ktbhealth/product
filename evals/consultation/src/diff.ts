import { alignWords, tokens, type DiffOp, type WordOp } from "@ktb/transcript-diff";

import { normalize, wer, type NormalizeOpts } from "./metrics.ts";

/**
 * Word-level alignment diff (P-081, T-136) — the read-side counterpart
 * of `wer()`: instead of a scalar, an ordered op list the validator UI
 * renders colored (ok / substituted / deleted / inserted) so a
 * reviewer sees WHERE the ASR erred, not just how much.
 *
 * Token display strings stay RAW (what the script/ASR actually said);
 * only equality uses the per-token fold below — lowercase + accent
 * fold + non-word strip, mirroring `metrics.normalize` minus number
 * expansion (expansion changes token COUNT, which would misalign the
 * displayed words against the source text).
 */

export { alignWords };
export type { DiffOp, WordOp };

export interface WordDiffSummary {
	readonly refWords: number;
	readonly hypWords: number;
	readonly ok: number;
	readonly sub: number;
	readonly del: number;
	readonly ins: number;
	/** Canonical normalized WER from metrics.ts — may differ slightly
	 * from (sub+del+ins)/refWords because the display fold skips
	 * number expansion. */
	readonly wer: number;
}

export interface WordDiff {
	readonly ops: readonly WordOp[];
	readonly summary: WordDiffSummary;
}

/** Diff two texts (raw tokenization + per-token fold for equality);
 * `opts` only steers the canonical `wer` in the summary. */
export const wordDiff = (refText: string, hypText: string, opts: NormalizeOpts = {}): WordDiff => {
	const ref = tokens(refText);
	const hyp = tokens(hypText);
	const ops = alignWords(ref, hyp);
	const count = (op: DiffOp) => ops.filter((o) => o.op === op).length;
	return {
		ops,
		summary: {
			refWords: ref.length,
			hypWords: hyp.length,
			ok: count("ok"),
			sub: count("sub"),
			del: count("del"),
			ins: count("ins"),
			wer: wer(refText, hypText, opts),
		},
	};
};
