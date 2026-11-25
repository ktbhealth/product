import * as Effect from "effect/Effect";

import type { EvalAnswer, EvalQuestion, RunRecord } from "@ktb/eval-core";

import { EvalPort, type PortError } from "./ports.ts";

/**
 * ASR error-range detection — decides WHICH chunks of a transcript a
 * cleanup corrector should see, using a System One decision model
 * (OpenJev-4B via `makeSystemOneEval`) as a per-segment classifier.
 *
 * Why: local chat correctors (qwen2.5:7b, phi4:14b) raise WER when
 * handed the whole transcript — they "fix" correct text. Measured on
 * consult-ptbr-synthetic@v2 (24 consults, 1078 faster-whisper
 * segments, labels from word alignment to the gold script):
 *
 *   detector               AUROC ≥1 err  AUROC ≥2 err  heldout ≥1
 *   OpenJev-4B (pt prompt)     0.747         0.774        0.768
 *   Whisper confidence         0.561         0.569        0.458
 *
 * At p ≥ 0.5 OpenJev flags 18% of segments at 80% precision; merged
 * into 97 ranges (90 contain an error) covering 21% of the words and
 * 41% of all word errors. The scores are compressed (p10 0.31, median
 * 0.41, p90 0.54) — they RANK well but the absolute value is not
 * calibrated for ASR review, so tune `threshold` on the train split.
 *
 * One request per batch of segments: the whole transcript is the
 * shared `state`, each question asks about one numbered segment.
 * Batching keeps a 12 GB GPU under its memory ceiling (~70 questions
 * in one request OOM'd the server); the state is identical across
 * batches.
 */

export type AsrRangeLang = "pt" | "en";

export interface AsrRangeOptions {
	/** Segments per judge request. Default 6. */
	readonly batchSize?: number;
	/** p(error) at or above which a segment is flagged. Default 0.5. */
	readonly threshold?: number;
	/** Prompt language. Default "pt" (higher precision on pt-BR). */
	readonly lang?: AsrRangeLang;
}

/** Inclusive segment-index range [start, end]. */
export interface AsrRange {
	readonly start: number;
	readonly end: number;
}

export interface AsrRangeResult {
	/** p(segment contains an ASR error), aligned with the input. */
	readonly scores: readonly number[];
	/** Runs of adjacent flagged segments, ascending. */
	readonly ranges: readonly AsrRange[];
	/** One RunRecord per judge request. */
	readonly records: readonly RunRecord[];
}

const PROMPTS: Record<AsrRangeLang, { task: string; question: (i: number) => string }> = {
	pt: {
		task:
			"Revisão de uma transcrição automática (ASR, Whisper) de uma consulta médica " +
			"em português brasileiro. O texto foi gerado a partir do áudio e pode conter " +
			"erros de reconhecimento de fala.",
		question: (i) =>
			`O segmento [${i}] contém erro de transcrição — palavra trocada por outra de som ` +
			"parecido, palavra inexistente ou sem sentido no contexto, nome de medicamento, " +
			"dose, número ou data reconhecidos errado? Ignore pontuação, maiúsculas e fala " +
			"coloquial ou repetida (isso é fala real, não erro).",
	},
	en: {
		task:
			"Review of an automatic speech recognition (ASR, Whisper) transcript of a " +
			"Brazilian Portuguese medical consultation. The text may contain speech " +
			"recognition errors.",
		question: (i) =>
			`Does segment [${i}] contain a transcription error — a word replaced by a ` +
			"similar-sounding one, a non-existent or nonsensical word in context, or a " +
			"misrecognized medication name, dose, number or date? Ignore punctuation, " +
			"casing and colloquial or repeated speech (that is real speech, not an error).",
	},
};

/** EvalAnswer.probability backs the CHOSEN verdict — recover p(yes). */
const pYes = (a: EvalAnswer): number => (a.value === true ? a.probability : 1 - a.probability);

/** Merge adjacent segments with score ≥ threshold into ranges. */
export const mergeFlaggedRanges = (
	scores: readonly number[],
	threshold: number,
): readonly AsrRange[] => {
	const ranges: { start: number; end: number }[] = [];
	scores.forEach((p, i) => {
		if (p < threshold) return;
		const last = ranges.at(-1);
		if (last !== undefined && last.end === i - 1) last.end = i;
		else ranges.push({ start: i, end: i });
	});
	return ranges;
};

/** Score every segment and return the ranges worth correcting. */
export const detectAsrErrorRanges = (
	segments: readonly { readonly text: string }[],
	options: AsrRangeOptions = {},
): Effect.Effect<AsrRangeResult, PortError, EvalPort> =>
	Effect.gen(function* () {
		const batchSize = Math.max(1, Math.floor(options.batchSize ?? 6));
		const threshold = options.threshold ?? 0.5;
		const prompt = PROMPTS[options.lang ?? "pt"];
		const port = yield* EvalPort;
		const state = {
			task: prompt.task,
			transcript_segments: segments.map((s, i) => `[${i}] ${s.text.trim()}`),
		};
		const scores: number[] = [];
		const records: RunRecord[] = [];
		for (let b = 0; b < segments.length; b += batchSize) {
			const questions: EvalQuestion[] = [];
			for (let i = b; i < Math.min(b + batchSize, segments.length); i++) {
				questions.push({ id: `s${i}`, kind: "noul", text: prompt.question(i) });
			}
			const { answers, record } = yield* port.judge({ state, questions });
			const byId = new Map(answers.map((a) => [a.id, a]));
			for (const q of questions) {
				const a = byId.get(q.id);
				// The port contract answers every question; a gap scores
				// as "no error" so it can never widen a range.
				scores.push(a === undefined ? 0 : pYes(a));
			}
			records.push(record);
		}
		return { scores, ranges: mergeFlaggedRanges(scores, threshold), records };
	});
