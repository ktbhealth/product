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

export type DiffOp = "ok" | "sub" | "del" | "ins";

export interface WordOp {
	readonly op: DiffOp;
	/** Raw reference token — "" for `ins`. */
	readonly ref: string;
	/** Raw hypothesis token — "" for `del`. */
	readonly hyp: string;
}

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

/** Display fold: lowercase + accent fold + strip non-word chars. */
const fold = (w: string): string =>
	w
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");

const tokens = (s: string): string[] =>
	s
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);

/**
 * Levenshtein with backtrace → ordered ops. Full n×m matrix — the
 * corpus is ~1.2k words/screen, ~1.5M cells is fine and the backtrace
 * needs the table anyway. Tie-break order matches the WER semantics:
 * prefer ok, then sub, then del, then ins.
 */
export const alignWords = (ref: readonly string[], hyp: readonly string[]): readonly WordOp[] => {
	const n = ref.length;
	const m = hyp.length;
	const eq = (i: number, j: number): boolean => fold(ref[i]!) === fold(hyp[j]!);
	// dp[i][j] = edit distance from ref[i..] to hyp[j..].
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = 0; i <= n; i++) dp[i]![m] = n - i;
	for (let j = 0; j <= m; j++) dp[n]![j] = m - j;
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i]![j] = eq(i, j)
				? dp[i + 1]![j + 1]!
				: 1 + Math.min(dp[i + 1]![j]!, dp[i]![j + 1]!, dp[i + 1]![j + 1]!);
		}
	}
	const ops: WordOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && eq(i, j)) {
			ops.push({ op: "ok", ref: ref[i]!, hyp: hyp[j]! });
			i++;
			j++;
		} else if (i < n && j < m && dp[i]![j] === 1 + dp[i + 1]![j + 1]!) {
			ops.push({ op: "sub", ref: ref[i]!, hyp: hyp[j]! });
			i++;
			j++;
		} else if (i < n && dp[i]![j] === 1 + dp[i + 1]![j]!) {
			ops.push({ op: "del", ref: ref[i]!, hyp: "" });
			i++;
		} else {
			ops.push({ op: "ins", ref: "", hyp: hyp[j]! });
			j++;
		}
	}
	return ops;
};

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
