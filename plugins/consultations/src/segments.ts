/**
 * ASR transcript segments (PL-023): the whisper `verbose_json`
 * `segments[]` persisted on `consultations.transcript_segments`.
 * They power the review-mode karaoke sync and uncertainty markers;
 * rows without them are the "legacy audio" class.
 */

export interface TranscriptSegment {
	/** Seconds from audio start. */
	readonly start: number;
	readonly end: number;
	readonly text: string;
	/** Whisper confidence proxy — lower = likelier ASR uncertainty. */
	readonly avgLogprob?: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Tolerant extraction of a segments array from a provider response —
 * tolerates `avg_logprob`/`avgLogprob` spellings and skips malformed
 * entries rather than rejecting the whole payload. Returns `null`
 * when the response carries no usable segments (legacy/shape drift).
 */
export function extractTranscriptSegments(raw: unknown): TranscriptSegment[] | null {
	if (!raw || typeof raw !== "object") return null;
	const list = (raw as Record<string, unknown>).segments;
	if (!Array.isArray(list)) return null;
	const out: TranscriptSegment[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const s = item as Record<string, unknown>;
		const start = num(s.start);
		const end = num(s.end);
		if (start === null || end === null || typeof s.text !== "string") continue;
		const lp = num(s.avg_logprob ?? s.avgLogprob);
		out.push(
			lp === null ? { start, end, text: s.text } : { start, end, text: s.text, avgLogprob: lp },
		);
	}
	return out.length ? out : null;
}

/** Serialize for the `transcript_segments` column (null stays null). */
export function serializeTranscriptSegments(
	segments: readonly TranscriptSegment[] | null | undefined,
): string | null {
	return segments != null && segments.length > 0 ? JSON.stringify(segments) : null;
}

/** Parse the stored column back — malformed JSON yields no segments. */
export function parseTranscriptSegments(raw: string | null | undefined): TranscriptSegment[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(s): s is TranscriptSegment =>
				!!s &&
				typeof s === "object" &&
				typeof (s as TranscriptSegment).start === "number" &&
				typeof (s as TranscriptSegment).end === "number" &&
				typeof (s as TranscriptSegment).text === "string",
		);
	} catch {
		return [];
	}
}

/** Fold case + diacritics and collapse whitespace — the normal form
 * evidence matching runs on, tolerant to the LLM's orthographic
 * clean-up of the ASR words. */
const fold = (s: string): string =>
	s
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();

/** Word-overlap ratio a segment must reach to be accepted as a fuzzy
 * evidence match — below it we risk pointing at the wrong passage. */
const EVIDENCE_OVERLAP_MIN = 0.6;

/**
 * Resolve an anamnesis evidence sentence to the timestamp of the
 * segment it was (probably) spoken in — the anchor chapter navigation
 * seeks to. Normalized substring match first (the LLM's evidence is
 * usually verbatim); falls back to best token overlap when cleanup
 * paraphrased the ASR words — a short segment fully contained in the
 * sentence still matches via the min() denominator.
 *
 * Returns `undefined` when nothing matches well enough: a missing
 * chapter is honest, a wrong timestamp is not.
 */
export function resolveSegmentStart(
	sentence: string,
	segments: readonly TranscriptSegment[],
): number | undefined {
	const needle = fold(sentence);
	if (!needle || segments.length === 0) return undefined;
	for (const s of segments) {
		if (fold(s.text).includes(needle)) return s.start;
	}
	const words = new Set(needle.split(" "));
	let best: { score: number; start: number } | null = null;
	for (const s of segments) {
		const tokens = new Set(fold(s.text).split(" ").filter(Boolean));
		if (tokens.size === 0) continue;
		let hit = 0;
		for (const w of words) if (tokens.has(w)) hit += 1;
		const score = hit / Math.min(words.size, tokens.size);
		if (score >= EVIDENCE_OVERLAP_MIN && (best === null || score > best.score)) {
			best = { score, start: s.start };
		}
	}
	return best?.start;
}
