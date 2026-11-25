#!/usr/bin/env bun
/* eslint-disable no-restricted-imports, no-restricted-globals --
 * edge tool: this script IS the filesystem/argv boundary for the
 * authored dataset (the domain pack itself stays port-pure — nothing
 * under src/ imports it). Same exemption class as app-level scripts. */
/**
 * materialize-ptbr-synthetic — writes the AUTHORED pt-BR cohort
 * (evals/consultation/src/ptbr/) into a suite workdir's dataset
 * store, in the exact row format `eval run`/`eval report` read.
 *
 *   bun evals/consultation/scripts/materialize-ptbr-synthetic.ts \
 *     --workdir /tmp/eval-ptbr-synthetic [--limit N] [--run-id id]
 *
 * Why a script and not `eval generate`: generate renders .eta
 * templates through TtsPort — template-synthetic content, not this
 * authored cohort. This script writes the same artifacts generate
 * would (samples + blob provenance + DatasetManifest + Experiment)
 * straight into <workdir>/manifest.sqlite, so the pinned dataset
 * `consult-ptbr-synthetic@v2` materializes byte-identically every run.
 *
 * Store format mirrors packages/eval-adapter-local/src/index.ts
 * (makeLocalStoreLayer / makeLocalEvalStoreLayer): doc-JSON rows in
 * sqlite, schema-decoded on write. If that store's schema changes,
 * this script must follow — it is the dataset's edge writer, kept
 * deliberately dependency-light (better-sqlite3 only, no adapter
 * imports) so the domain pack never depends on its own adapters.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { Schema } from "effect";

import { suite } from "../consult-ptbr-synthetic.suite.ts";
import { DatasetManifest, Experiment } from "@ktb/eval-core";
import {
	buildPtbrSyntheticSamples,
	PTBR_SYNTHETIC_DATASET_ID,
	PTBR_SYNTHETIC_DATASET_VERSION,
} from "../src/ptbr/index.ts";
import { Sample } from "../src/schema.ts";

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

const decodeSample = Schema.decodeUnknownSync(Sample);
const decodeManifest = Schema.decodeUnknownSync(DatasetManifest);
const decodeExperiment = Schema.decodeUnknownSync(Experiment);

// ---------- args ----------

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? undefined : args[i + 1];
};

const workdirRaw = flag("workdir") ?? path.join(os.tmpdir(), "eval-ptbr-synthetic");
const limitRaw = flag("limit");
const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
	console.error(`--limit must be an integer >= 1, got: ${limitRaw}`);
	process.exit(2);
}
const runId = flag("run-id") ?? `gen-${suite.id}-${Date.now()}`;

// Same scratch-path guard as eval-cli's workdirFlag — a bad argv
// must not write into a real directory.
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

// ---------- store ----------

fs.mkdirSync(path.join(resolved, "blobs"), { recursive: true });
const db = new Database(path.join(resolved, "manifest.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("busy_timeout = 5000");
db.exec(
	`CREATE TABLE IF NOT EXISTS samples (
		id TEXT PRIMARY KEY,
		dataset_version TEXT NOT NULL,
		origin TEXT NOT NULL,
		doc TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS results (
		run_id TEXT NOT NULL,
		sample_id TEXT NOT NULL,
		doc TEXT NOT NULL,
		PRIMARY KEY (run_id, sample_id)
	);
	CREATE TABLE IF NOT EXISTS blob_meta (
		uri TEXT PRIMARY KEY,
		doc TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS experiments (
		id TEXT PRIMARY KEY,
		doc TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS dataset_manifests (
		id TEXT NOT NULL,
		version TEXT NOT NULL,
		doc TEXT NOT NULL,
		PRIMARY KEY (id, version)
	);
	CREATE TABLE IF NOT EXISTS calibration_reports (
		id TEXT PRIMARY KEY,
		doc TEXT NOT NULL
	)`,
);

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
const upsertExperiment = db.prepare(
	`INSERT INTO experiments (id, doc) VALUES (@id, @doc)
	 ON CONFLICT(id) DO UPDATE SET doc = @doc`,
);
const selectManifest = db.prepare(`SELECT doc FROM dataset_manifests WHERE id = ? AND version = ?`);
const upsertManifest = db.prepare(
	`INSERT INTO dataset_manifests (id, version, doc) VALUES (@id, @version, @doc)
	 ON CONFLICT(id, version) DO UPDATE SET doc = @doc`,
);

// ---------- materialize ----------

const startedAt = Date.now();
const samples = buildPtbrSyntheticSamples(limit === undefined ? undefined : { limit });
const datasetVersion = `${PTBR_SYNTHETIC_DATASET_ID}-${PTBR_SYNTHETIC_DATASET_VERSION}`;

const registerManifest = db.transaction((m: DatasetManifest) => {
	const existing = selectManifest.get(m.id, m.version) as { doc: string } | undefined;
	if (existing !== undefined) {
		const prior = JSON.parse(existing.doc) as DatasetManifest;
		if (prior.contentHash !== m.contentHash) {
			throw new Error(
				`dataset ${m.id}@${m.version} already registered with contentHash ` +
					`${prior.contentHash} — refusing to overwrite with ${m.contentHash}; ` +
					`bump the suite's dataset version`,
			);
		}
		return; // identical re-registration — idempotent
	}
	upsertManifest.run({ id: m.id, version: m.version, doc: JSON.stringify(m) });
});

try {
	for (const raw of samples) {
		const sample = decodeSample(raw);
		upsertSample.run({
			id: sample.id,
			dataset_version: sample.datasetVersion,
			origin: sample.origin,
			doc: JSON.stringify(sample),
		});
		// Audio provenance — the pending:// placeholder stands in for
		// the future TTS render; "synthetic" is the honest origin for
		// authored-text audio once it exists.
		if (sample.audio !== undefined) {
			upsertBlobMeta.run({
				uri: sample.audio.uri,
				doc: JSON.stringify({ origin: "synthetic" }),
			});
		}
	}

	// Content pin — identical algorithm to eval generate
	// (commands/generate.ts): sorted "id:scriptHash" pairs hashed.
	const contentHash = sha256Hex(
		samples
			.map((s) => `${s.id}:${s.scriptHash}`)
			.sort()
			.join("\n"),
	);
	const datasetDoc: DatasetManifest = decodeManifest({
		id: PTBR_SYNTHETIC_DATASET_ID,
		version: PTBR_SYNTHETIC_DATASET_VERSION,
		domain: suite.domain,
		generator: {
			suiteId: suite.id,
			source: "authored",
			pack: "evals/consultation/src/ptbr",
			materializer: "scripts/materialize-ptbr-synthetic.ts",
			count: samples.length,
			...(limit !== undefined ? { limit } : {}),
			locale: "pt-BR",
			noise: "clinic",
			datasetVersion,
		},
		provenance: {
			generatedBy: "materialize-ptbr-synthetic",
			runId,
			task: "T-042",
		},
		createdAt: startedAt,
		sampleCount: samples.length,
		contentHash,
	});
	registerManifest(datasetDoc);

	const experiment: Experiment = decodeExperiment({
		id: runId,
		kind: "generate",
		suiteId: suite.id,
		manifestHash: sha256Hex(JSON.stringify(suite)),
		profile: suite.adapterProfile ?? "stub",
		dataset: { id: PTBR_SYNTHETIC_DATASET_ID, version: PTBR_SYNTHETIC_DATASET_VERSION },
		startedAt,
		finishedAt: Date.now(),
		summary: {
			samples: samples.length,
			source: "authored",
			datasetVersion,
			materializer: "scripts/materialize-ptbr-synthetic.ts",
		},
	});
	upsertExperiment.run({ id: experiment.id, doc: JSON.stringify(experiment) });
} finally {
	db.close();
}

console.log(
	`materialized ${samples.length} authored samples (${datasetVersion}) → ${resolved}\n` +
		`next: bun apps/cli/src/main.ts eval run ${suite.id} --workdir ${resolved}`,
);
