/**
 * Word/sentence alignment diff — the read-side counterpart of WER:
 * instead of a scalar, an ordered op list a reviewer renders colored
 * (ok / substituted / deleted / inserted) to see WHERE text changed.
 *
 * Two layers, by design: `alignWords` is a full O(n×m) Levenshtein —
 * fine inside a sentence pair (~20×20), fatal on a whole transcript
 * (5k×5k ≈ 25M cells). `sentenceDiff` first anchors sentences with a
 * cheap windowed token-overlap pass, then word-diffs only inside each
 * pair — linear-ish total work regardless of transcript length.
 *
 * Token display strings stay RAW (what the source actually said);
 * only equality uses the per-token fold — lowercase + accent fold +
 * non-word strip.
 */

export type DiffOp = "ok" | "sub" | "del" | "ins";

export interface WordOp {
	readonly op: DiffOp;
	/** Raw reference token — "" for `ins`. */
	readonly ref: string;
	/** Raw hypothesis token — "" for `del`. */
	readonly hyp: string;
}

/** Display fold: lowercase + accent fold + strip non-word chars. */
export const fold = (w: string): string =>
	w
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");

export const tokens = (s: string): string[] =>
	s
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);

/**
 * Levenshtein with backtrace → ordered ops. Full n×m matrix — only
 * call this on small units (sentence pairs, short lines); for whole
 * texts use `sentenceDiff`. Tie-break order matches WER semantics:
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
				: 1 + Math.min(dp[i + 1]![j]!, dp[i + 1]![j + 1]!, dp[i + 1]![j + 1]!);
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

/**
 * Sentence pair produced by `sentenceDiff`. `ref` is the original-side
 * sentence ("" when the corrected side inserted one), `hyp` the
 * corrected-side one ("" when deleted). `ops` is the intra-pair word
 * diff — all `del` for a removed sentence, all `ins` for an inserted.
 */
export interface SentencePair {
	readonly ref: string;
	readonly hyp: string;
	readonly ops: readonly WordOp[];
}

/** Split into sentences on newlines and end-punctuation + whitespace. */
export const splitSentences = (text: string): string[] =>
	text
		.split(/\n+|(?<=[.!?…])\s+/u)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

/** Min token-overlap (shared / min(len)) for two sentences to pair. */
const PAIR_OVERLAP_MIN = 0.5;
/** How many hypothesis sentences ahead a reference may look for its
 * pair — bounds the anchoring pass and mirrors how little a cleanup
 * pass reorders content. */
const PAIR_WINDOW = 5;

const overlap = (a: string, b: string): number => {
	const aw = new Set(tokens(a).map(fold).filter(Boolean));
	const bw = new Set(tokens(b).map(fold).filter(Boolean));
	const denom = Math.min(aw.size, bw.size);
	if (denom === 0) return 0;
	let hit = 0;
	for (const w of aw) if (bw.has(w)) hit += 1;
	return hit / denom;
};

/**
 * Bounded diff of two near-identical texts (ASR original vs LLM
 * corrected): anchors each reference sentence to the best overlapping
 * hypothesis sentence within PAIR_WINDOW, emits unpaired sides as
 * deletions/insertions, and word-diffs inside each pair.
 *
 * Deliberately greedy: when cleanup rewrites heavily the pair just
 * fails to anchor and the region renders as del+ins — which is the
 * truthful answer ("this part changed") rather than a wrong alignment.
 */
export const sentenceDiff = (refText: string, hypText: string): readonly SentencePair[] => {
	const refs = splitSentences(refText);
	const hyps = splitSentences(hypText);
	const pairs: { ref: string; hyp: string }[] = [];
	let cursor = 0;
	for (const r of refs) {
		let best = -1;
		let bestScore = PAIR_OVERLAP_MIN;
		const limit = Math.min(cursor + PAIR_WINDOW, hyps.length);
		for (let j = cursor; j < limit; j++) {
			const score = overlap(r, hyps[j]!);
			if (score > bestScore) {
				bestScore = score;
				best = j;
			}
		}
		if (best === -1) {
			pairs.push({ ref: r, hyp: "" });
		} else {
			for (let j = cursor; j < best; j++) pairs.push({ ref: "", hyp: hyps[j]! });
			pairs.push({ ref: r, hyp: hyps[best]! });
			cursor = best + 1;
		}
	}
	for (let j = cursor; j < hyps.length; j++) pairs.push({ ref: "", hyp: hyps[j]! });
	return pairs.map((p) => ({ ...p, ops: alignWords(tokens(p.ref), tokens(p.hyp)) }));
};
