/**
 * gate.ts — CleanupGate implementations: which spans of an ASR
 * transcript the corrector sees.
 *
 *   systemone    — live detection: every segment is scored by the
 *                  System One decision model (OpenJev via
 *                  makeSystemOneEval → EVAL_SYSTEMONE_URL) through the
 *                  domain's detectAsrErrorRanges; flagged neighbors
 *                  merge into correction ranges. The detector's
 *                  EvalPort is built HERE — the run's judge adapter
 *                  stays untouched (a stub-judge profile still gates).
 *   scores-file  — the same detector's scores replayed from a JSON
 *                  file (<workdir>/cleanup-gate-scores.json by CLI
 *                  default; written by scripts/score-cleanup-gate.ts).
 *                  Lets a 12 GB GPU run detection and correction in
 *                  separate phases — OpenJev (~9 GB) and a chat
 *                  corrector (~5 GB) do not fit together.
 *
 * The scores file is keyed by sampleId and pinned to the ASR text's
 * content hash: a transcript re-transcribed differently (model swap,
 * server drift) fails the hash check honestly rather than applying
 * stale per-segment scores to shifted text.
 */

import * as fs from "node:fs";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PortError } from "@ktb/eval-core";
import {
	CleanupGate,
	detectAsrErrorRanges,
	fnvHex,
	mergeFlaggedRanges,
	type AsrRangeLang,
} from "@ktb/eval-consultation";

import { makeSystemOneEval } from "./systemone.ts";

export interface SystemOneCleanupGateOptions {
	/** System One server base URL (EVAL_SYSTEMONE_URL). */
	readonly baseUrl: string;
	/** Model name sent in the request body — opaque to self-hosted
	 * servers; see makeSystemOneEval. */
	readonly model?: string;
	/** p(error) at or above which a segment is flagged. Default 0.5. */
	readonly threshold?: number;
	/** Segments per judge request. Default 6 — ~70 in one request
	 * OOM'd a 12 GB OpenJev server. */
	readonly batchSize?: number;
	/** Detector prompt language. Default "pt". */
	readonly lang?: AsrRangeLang;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
}

export const makeSystemOneCleanupGate = (
	opts: SystemOneCleanupGateOptions,
): Layer.Layer<CleanupGate> => {
	// The detector's own EvalPort — built once per gate, independent
	// of the run's judge adapter.
	const evalLayer = makeSystemOneEval({
		baseUrl: opts.baseUrl,
		...(opts.model !== undefined ? { model: opts.model } : {}),
		...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
	});
	return Layer.succeed(
		CleanupGate,
		CleanupGate.of({
			name: "systemone",
			select: ({ segments }) =>
				detectAsrErrorRanges(segments, {
					...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
					...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
					...(opts.lang !== undefined ? { lang: opts.lang } : {}),
				}).pipe(
					Effect.provide(evalLayer),
					Effect.map((r) => ({
						ranges: r.ranges,
						segmentsScored: segments.length,
						records: r.records,
					})),
				),
		}),
	);
};

/** One scores-file entry — written by scripts/score-cleanup-gate.ts.
 * `textHash` pins the scores to the ASR text they were computed over
 * (fnvHex); `scores[i]` is p(segment i contains an ASR error). */
interface ScoresFileEntry {
	readonly textHash: string;
	readonly scores: readonly number[];
}

const isScoresFileEntry = (v: unknown): v is ScoresFileEntry =>
	typeof v === "object" &&
	v !== null &&
	typeof (v as ScoresFileEntry).textHash === "string" &&
	Array.isArray((v as ScoresFileEntry).scores) &&
	(v as ScoresFileEntry).scores.every((s) => typeof s === "number" && Number.isFinite(s));

export interface ScoresFileCleanupGateOptions {
	/** Path to the JSON scores map: { [sampleId]: { textHash, scores } }. */
	readonly path: string;
	/** p(error) at or above which a segment is flagged. Default 0.5. */
	readonly threshold?: number;
}

export const makeScoresFileCleanupGate = (
	opts: ScoresFileCleanupGateOptions,
): Layer.Layer<CleanupGate> => {
	const threshold = opts.threshold ?? 0.5;
	// Read once, lazily — the file is immutable for the run, and the
	// error stays a typed PortError inside select rather than a layer-
	// construction defect.
	let cache: Readonly<Record<string, unknown>> | undefined;
	const load = Effect.try({
		try: (): Readonly<Record<string, unknown>> => {
			if (cache === undefined) {
				const parsed: unknown = JSON.parse(fs.readFileSync(opts.path, "utf8"));
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error("expected a JSON object keyed by sampleId");
				}
				cache = parsed as Record<string, unknown>;
			}
			return cache;
		},
		catch: (e) =>
			new PortError({
				port: "cleanup-gate",
				message: `scores file ${opts.path}: ${String(e)}`,
				cause: e,
			}),
	});
	return Layer.succeed(
		CleanupGate,
		CleanupGate.of({
			name: "scores-file",
			select: ({ sampleId, text, segments }) =>
				Effect.gen(function* () {
					const file = yield* load;
					const entry = file[sampleId];
					if (entry === undefined) {
						return yield* new PortError({
							port: "cleanup-gate",
							message: `no gate scores for sample "${sampleId}" in ${opts.path}`,
						});
					}
					if (!isScoresFileEntry(entry)) {
						return yield* new PortError({
							port: "cleanup-gate",
							message: `malformed gate scores for "${sampleId}" in ${opts.path}`,
						});
					}
					if (entry.textHash !== fnvHex(text)) {
						return yield* new PortError({
							port: "cleanup-gate",
							message:
								`gate scores for "${sampleId}" were computed over a different ASR text — ` +
								"re-score before gating",
						});
					}
					if (entry.scores.length !== segments.length) {
						return yield* new PortError({
							port: "cleanup-gate",
							message:
								`gate scores for "${sampleId}" cover ${entry.scores.length} segments, ` +
								`transcript has ${segments.length}`,
						});
					}
					return {
						ranges: mergeFlaggedRanges(entry.scores, threshold),
						segmentsScored: segments.length,
						records: [],
					};
				}),
		}),
	);
};
