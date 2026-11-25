#!/usr/bin/env bun
/**
 * score-cleanup-gate — phase 1 of the gated cleanup flow on a
 * memory-bound GPU.
 *
 * Transcribes every sample of a materialized dataset with
 * faster-whisper, then scores each ASR segment with the System One
 * detector (OpenJev via detectAsrErrorRanges → EVAL_SYSTEMONE_URL)
 * and writes <workdir>/cleanup-gate-scores.json:
 *
 *   { "<sampleId>": { "textHash": fnv(asrText), "scores": [p, …] } }
 *
 * EVAL_CLEANUP_GATE=scores-file replays this file (see
 * src/gate.ts) — the scores are pinned to the transcript's content
 * hash, so a phase-2 run that re-transcribes to different text fails
 * the hash check honestly instead of applying stale segment scores.
 *
 * Why two phases: on a 12 GB GPU the detector (~9 GB) and a chat
 * corrector (~5 GB) do not fit together. Score with the corrector
 * unloaded, then bring the detector down and run the gated eval.
 *
 *   EVAL_SYSTEMONE_URL=http://127.0.0.1:8009 \
 *     bun packages/eval-adapter-local/scripts/score-cleanup-gate.ts \
 *       --workdir /tmp/eval-ptbr-synthetic-v2
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AsrPort, detectAsrErrorRanges, fnvHex } from "@ktb/eval-consultation";

import { makeLocalAsr } from "../src/asr.ts";
import { makeSystemOneEval } from "../src/systemone.ts";

// ---------- args ----------

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? undefined : args[i + 1];
};

const workdir = flag("workdir");
if (workdir === undefined) {
	console.error("usage: score-cleanup-gate --workdir <dir> [--dataset-version v] [--limit N]");
	process.exit(2);
}
const datasetVersion = flag("dataset-version");
const asrUrl = flag("asr-url") ?? process.env.EVAL_ASR_URL ?? "http://127.0.0.1:8765";
const soUrl = process.env.EVAL_SYSTEMONE_URL ?? "http://127.0.0.1:8009";
const outPath = flag("out") ?? path.join(workdir, "cleanup-gate-scores.json");
const limitRaw = flag("limit");
const limitParsed = limitRaw === undefined ? NaN : Number.parseInt(limitRaw, 10);
const limit = Number.isFinite(limitParsed) ? limitParsed : undefined;
const batchRaw = flag("batch-size");
const batchParsed = batchRaw === undefined ? NaN : Number.parseInt(batchRaw, 10);
const batchSize = Number.isFinite(batchParsed) ? batchParsed : undefined;
const num = (v: string | undefined): number | undefined => {
	const n = v === undefined ? NaN : Number(v);
	return Number.isFinite(n) ? n : undefined;
};
const asrTimeoutMs = num(process.env.EVAL_ASR_TIMEOUT_MS) ?? 300_000;
const soTimeoutMs = num(process.env.EVAL_SYSTEMONE_TIMEOUT_MS) ?? 120_000;

// ---------- cohort ----------

interface SampleRow {
	readonly id: string;
	readonly audio?: { uri?: string };
}

const db = new Database(path.join(workdir, "manifest.sqlite"));
const rows = (
	datasetVersion === undefined
		? db.prepare(`SELECT doc FROM samples`).all()
		: db.prepare(`SELECT doc FROM samples WHERE dataset_version = ?`).all(datasetVersion)
) as { doc: string }[];
const cohort = rows
	.map((r) => JSON.parse(r.doc) as SampleRow)
	.sort((a, b) => a.id.localeCompare(b.id))
	.slice(0, limit);
console.log(
	`scoring ${cohort.length} samples${datasetVersion === undefined ? "" : ` (dataset ${datasetVersion})`} → ${outPath}`,
);

// ---------- run ----------

interface ScoresEntry {
	readonly textHash: string;
	readonly scores: readonly number[];
}

const scores: Record<string, ScoresEntry> = fs.existsSync(outPath)
	? (JSON.parse(fs.readFileSync(outPath, "utf8")) as Record<string, ScoresEntry>)
	: {};
let scored = 0;

const program = Effect.forEach(
	cohort,
	(sample) =>
		Effect.gen(function* () {
			const uri = sample.audio?.uri;
			if (uri === undefined) {
				console.log(`  ${sample.id}: no audio — skipped`);
				return;
			}
			const asr = yield* AsrPort;
			const t0 = Date.now();
			const { asr: result } = yield* asr.transcribe({ uri }, { language: "pt" });
			const asrMs = Date.now() - t0;
			const det = yield* detectAsrErrorRanges(result.segments, {
				...(batchSize !== undefined ? { batchSize } : {}),
			});
			scores[sample.id] = { textHash: fnvHex(result.text), scores: det.scores };
			// Persist after every sample — a crash keeps the prefix, and
			// the file is valid JSON at every intermediate state.
			fs.writeFileSync(outPath, `${JSON.stringify(scores, null, 2)}\n`);
			scored++;
			const flagged = det.ranges.reduce((acc, r) => acc + r.end - r.start + 1, 0);
			console.log(
				`  ${sample.id}: ${result.segments.length} segments, ` +
					`${det.ranges.length} ranges (${flagged} flagged) ` +
					`[asr ${(asrMs / 1000).toFixed(0)}s, detect ${((Date.now() - t0 - asrMs) / 1000).toFixed(0)}s]`,
			);
		}),
	{ concurrency: 1, discard: true },
);

// Two ports, one layer each — the ASR hits the whisper sidecar, the
// detector's EvalPort hits the System One server.
const layers = Layer.merge(
	makeLocalAsr({ baseUrl: asrUrl, timeoutMs: asrTimeoutMs }),
	makeSystemOneEval({ baseUrl: soUrl, timeoutMs: soTimeoutMs }),
);

await Effect.runPromise(program.pipe(Effect.provide(layers)));
db.close();
console.log(`\n${scored} samples scored → ${outPath}`);
