#!/usr/bin/env bun
/**
 * render-ptbr-synthetic-audio — T-164. Synthesizes real TTS audio for the
 * AUTHORED pt-BR cohort (`consult-ptbr-synthetic`) and rewrites each
 * sample's `audio.uri` from the `pending://` placeholder to the
 * produced `file://` ref, so real ASR adapters (faster-whisper)
 * produce a true WER signal instead of the stub path.
 *
 *   # 1. materialize the cohort first (writes samples + manifest):
 *   bun evals/consultation/scripts/materialize-ptbr-synthetic.ts \
 *     --workdir /tmp/eval-ptbr-synthetic
 *
 *   # 2. render audio into the same workdir:
 *   bun packages/eval-adapter-local/scripts/render-ptbr-synthetic-audio.ts \
 *     --workdir /tmp/eval-ptbr-synthetic [--limit N] [--ids id1,id2,...] \
 *     [--concurrency N]
 *
 * Sample selection: the store lists rows ordered by id, but the eval
 * runner consumes the cohort in AUTHORED dataset order
 * (PTBR_CONSULTATIONS — general-practice first). Plain `--limit N`
 * therefore slices `pending` sorted by that authored order so smoke
 * runs render the same samples the eval would score first. `--ids`
 * pins an explicit comma-separated id list (still filtered to
 * `pending://` rows and still `--limit`-capped) for targeted renders.
 *
 * Then run the pipeline with a real ASR profile:
 *
 *   bun apps/cli/src/main.ts eval run consult-ptbr-synthetic \
 *     --workdir /tmp/eval-ptbr-synthetic --profile local-asr
 *
 * Requires `edge-tts` + `ffmpeg` on PATH (`uv tool install edge-tts`).
 * edge-tts is a HOSTED endpoint — the cohort is authored synthetic
 * text, never real consult/PHI (LGPD), and blob_meta stays
 * `synthetic` so egress adapters keep accepting it.
 *
 * Idempotent: samples whose audio.uri already starts with `file://`
 * are skipped, so re-runs only fill gaps (and `--limit` smokes are
 * safe). Per-speaker voices come from the sample's own persona
 * (doctor/patient × gender → the adapter's pt-BR voice aliases);
 * `acoustic` is stamped with the real ttsModel/voiceId/speakerVoices
 * so reports can attribute the render.
 *
 * Store format mirrors materialize-ptbr-synthetic.ts / the local eval
 * store (doc-JSON rows in <workdir>/manifest.sqlite). If that schema
 * changes, this script must follow.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { TtsPort } from "@ktb/eval-consultation";
import { PTBR_CONSULTATIONS, ptbrSyntheticSampleId } from "@ktb/eval-consultation/ptbr";
import { Sample } from "@ktb/eval-consultation/schema";

import { makeLocalTts } from "../src/tts.ts";

const decodeSample = Schema.decodeUnknownSync(Sample);

// ---------- args ----------

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? undefined : args[i + 1];
};

const workdirRaw = flag("workdir");
if (workdirRaw === undefined) {
	console.error("--workdir is required (the materialized eval workdir)");
	process.exit(2);
}
const limitRaw = flag("limit");
const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
	console.error(`--limit must be an integer >= 1, got: ${limitRaw}`);
	process.exit(2);
}
const idsRaw = flag("ids");
const wantedIds =
	idsRaw === undefined
		? undefined
		: new Set(
				idsRaw
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s !== ""),
			);
if (wantedIds !== undefined && wantedIds.size === 0) {
	console.error("--ids must list at least one sample id");
	process.exit(2);
}
const concurrencyRaw = flag("concurrency");
const concurrency = concurrencyRaw === undefined ? 2 : Number.parseInt(concurrencyRaw, 10);
if (!Number.isInteger(concurrency) || concurrency < 1) {
	console.error(`--concurrency must be an integer >= 1, got: ${concurrencyRaw}`);
	process.exit(2);
}
const datasetVersion = flag("dataset") ?? "consult-ptbr-synthetic-v2";

// Same scratch-path guard as materialize-ptbr-synthetic.ts / eval-cli's
// workdirFlag — a bad argv must not write into a real directory.
const resolved = path.resolve(workdirRaw);
const scratchRoots = [
	path.resolve(os.tmpdir()),
	fs.realpathSync(os.tmpdir()),
	path.resolve(process.cwd(), "tmp"),
	...(process.env.EVAL_WORKDIR_ROOTS ?? "")
		.split(path.delimiter)
		.filter((r) => r !== "")
		.map((r) => path.resolve(r)),
];
if (!scratchRoots.some((r) => resolved === r || resolved.startsWith(`${r}${path.sep}`))) {
	console.error(`--workdir must live under ${scratchRoots.join(" or ")}, got: ${workdirRaw}`);
	process.exit(2);
}

const dbPath = path.join(resolved, "manifest.sqlite");
if (!fs.existsSync(dbPath)) {
	console.error(`no manifest.sqlite under ${resolved} — run materialize-ptbr-synthetic.ts first`);
	process.exit(2);
}

// ---------- store ----------

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("busy_timeout = 5000");

const upsertSample = db.prepare(
	`INSERT INTO samples (id, dataset_version, origin, doc)
	 VALUES (@id, @dataset_version, @origin, @doc)
	 ON CONFLICT(id) DO UPDATE SET
		dataset_version = @dataset_version, origin = @origin, doc = @doc`,
);
const upsertBlobMeta = db.prepare(
	`INSERT INTO blob_meta (uri, doc) VALUES (@uri, @doc)
	 ON CONFLICT(uri) DO UPDATE SET doc = @doc`,
);

// ---------- pending cohort ----------

const rows = db
	.prepare(`SELECT id, dataset_version, doc FROM samples WHERE dataset_version = ? ORDER BY id`)
	.all(datasetVersion) as { id: string; dataset_version: string; doc: string }[];

const all = rows.map((r) => decodeSample(JSON.parse(r.doc)));
const alreadyDone = all.filter((s) => s.audio?.uri.startsWith("file://") === true).length;

// Authored dataset order — the eval runner consumes the cohort in
// PTBR_CONSULTATIONS order, so --limit must slice the same way or
// smoke renders target the wrong samples (the store's ORDER BY id
// is alphabetical, not authored).
const authoredOrder = new Map(
	PTBR_CONSULTATIONS.map((c, i) => [ptbrSyntheticSampleId(c), i] as const),
);
const byAuthoredOrder = (a: Sample, b: Sample): number => {
	const ia = authoredOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
	const ib = authoredOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
	return ia - ib || a.id.localeCompare(b.id);
};

let cohort = all;
if (wantedIds !== undefined) {
	cohort = all.filter((s) => wantedIds.has(s.id));
	const missing = [...wantedIds].filter((id) => !all.some((s) => s.id === id));
	if (missing.length > 0) {
		console.error(`--ids not found in dataset ${datasetVersion}: ${missing.join(", ")}`);
		db.close();
		process.exit(2);
	}
}
const pending = cohort
	.filter((s) => s.audio?.uri.startsWith("pending://") === true)
	.sort(byAuthoredOrder)
	.slice(0, limit);
if (pending.length === 0) {
	console.log(`nothing to render — ${rows.length} samples already carry file:// audio`);
	db.close();
	process.exit(0);
}

// ---------- voices ----------

/** doctor/patient × patient-gender → adapter voice aliases
 * (DEFAULT_VOICES in src/tts.ts). Distinct aliases per speaker keep
 * diarization honest; unknown genders fall back to the male pair. */
const doctorVoice = (gender: string | undefined): string =>
	gender === "f" ? "br_female_1" : "br_male_1";
const patientVoice = (gender: string | undefined): string =>
	gender === "f" ? "br_female_2" : "br_male_2";

// ---------- render ----------

const ttsLayer = makeLocalTts({ workDir: resolved, voiceMap: {} });

const renderOne = (sample: Sample) =>
	Effect.gen(function* () {
		const tts = yield* TtsPort;
		const doctor = doctorVoice(sample.persona.doctor?.gender);
		const patient = patientVoice(sample.persona.gender);
		const speakerVoices = { doctor, patient };
		const { audio } = yield* tts.synthesize({
			script: sample.script,
			voiceId: doctor,
			acoustic: {
				ttsModel: "edge-tts",
				voiceId: doctor,
				noise: sample.acoustic?.noise ?? "clinic",
				sampleRate: sample.acoustic?.sampleRate ?? 16000,
				speakerVoices,
			},
			...(sample.turns !== undefined ? { turns: sample.turns } : {}),
			speakerVoices,
		});
		const next = decodeSample({
			...sample,
			audio: {
				uri: audio.uri,
				...(audio.size !== undefined ? { size: audio.size } : {}),
				...(audio.contentType !== undefined ? { contentType: audio.contentType } : {}),
			},
			acoustic: {
				ttsModel: "edge-tts",
				voiceId: doctor,
				noise: sample.acoustic?.noise ?? "clinic",
				sampleRate: sample.acoustic?.sampleRate ?? 16000,
				speakerVoices,
			},
		});
		// Durable per-sample — a crash mid-run keeps finished renders.
		upsertSample.run({
			id: next.id,
			dataset_version: next.datasetVersion,
			origin: next.origin,
			doc: JSON.stringify(next),
		});
		upsertBlobMeta.run({ uri: audio.uri, doc: JSON.stringify({ origin: "synthetic" }) });
		return { id: sample.id, uri: audio.uri };
	});

const failures: string[] = [];
const program = Effect.forEach(
	pending,
	(sample) =>
		renderOne(sample).pipe(
			Effect.catch((e) =>
				Effect.sync(() => {
					failures.push(`${sample.id}: ${String(e)}`);
					console.error(`FAIL ${sample.id}: ${String(e)}`);
				}),
			),
		),
	{ concurrency },
).pipe(Effect.asVoid);

await Effect.runPromise(program.pipe(Effect.provide(ttsLayer)));
db.close();

const rendered = pending.length - failures.length;
console.log(
	`rendered ${rendered}/${pending.length} samples → ${resolved}/audio\n` +
		(alreadyDone > 0 ? `skipped ${alreadyDone} already-rendered rows\n` : "") +
		`next: bun apps/cli/src/main.ts eval run consult-ptbr-synthetic --workdir ${resolved} --profile local-asr`,
);
if (failures.length > 0) process.exitCode = 1;
