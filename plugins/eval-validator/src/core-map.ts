import type { DatasetPin, Experiment, RunRecord } from "@ktb/eval-core";
import type { JsonObject } from "effect/Schema";

import { evalRunRecord, type EvalRun, type EvalRunRecord, type EvalRunSample } from "./schema.ts";

/**
 * Platform-run → eval-core artifact mapping (WS-D / PL-009): the
 * validator's `eval_run` row becomes an eval-core `Experiment`, its
 * per-stage `RunRecord`s land in `eval_run_record`, and the cohort's
 * stored `DatasetManifest` resolves to the `DatasetPin` the
 * experiment pins.
 *
 * Pure module — no Effect, no db. Same constraint as
 * plugins/eval-persona/src/manifest.ts: the hash is a local FNV-1a
 * (plugins may not import node:crypto; crypto.subtle is async and
 * this mapping must stay sync). Duplicated ~10 lines on purpose —
 * plugins must not import each other's src.
 */

/** FNV-1a 32-bit → 8 lowercase hex chars (see manifest.ts). */
const fnv1a = (input: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
};

/** Tolerant JSON-column reader shared by the run paths (index.ts +
 * run-job.ts) — malformed stored JSON degrades to the fallback rather
 * than throwing mid-run. */
export const parseJson = <T>(s: string | null, fallback: T): T => {
	if (s === null) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

/** Resolve the dataset pin for a run: parse the instance's stored
 * DatasetManifest JSON ({id, version}); when the instance row or its
 * manifest is missing/broken, fall back to the deterministic
 * `eval-instance-<id>` id with version "unknown" — the experiment
 * still records WHAT it tried to pin rather than inventing a version. */
export const datasetPinFor = (
	manifestJson: string | null,
	instanceId: number | null,
): DatasetPin => {
	const fallback: DatasetPin = {
		id: `eval-instance-${instanceId ?? "unknown"}`,
		version: "unknown",
	};
	if (manifestJson === null) return fallback;
	try {
		const m = JSON.parse(manifestJson) as { id?: unknown; version?: unknown };
		if (typeof m.id === "string" && typeof m.version === "string") {
			return { id: m.id, version: m.version };
		}
	} catch {
		// Malformed manifest JSON — same fallback as a missing row.
	}
	return fallback;
};

/** `eval_run` row → eval-core Experiment. `manifestHash` fingerprints
 * the run's recorded input set (params JSON) plus the dataset pin —
 * same inputs + same pin reproduce the hash. `summary` is the run's
 * metrics bag parsed back to an object (malformed/non-object → {}).
 * Gates stay absent: the platform runner doesn't produce per-sample
 * verdicts the gate policy consumes. `startedAt` falls back to
 * `createdAt` for runs that never reached `running` (e.g. a runner
 * that failed before the status flip could be observed). */
export const runToExperiment = (
	run: EvalRun,
	samples: readonly EvalRunSample[],
	datasetPin: DatasetPin,
): Experiment => {
	void samples; // reserved — per-sample detail lives on eval_run_sample rows
	const parsed = parseJson<unknown>(run.summary, {});
	const summary: JsonObject =
		parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as JsonObject)
			: {};
	const base = {
		id: `eval-run-${run.id}`,
		kind: "run" as const,
		suiteId: "eval.consultation",
		manifestHash: fnv1a(`${run.params}::${JSON.stringify(datasetPin)}`),
		profile: "platform",
		dataset: datasetPin,
		startedAt: run.startedAt?.getTime() ?? run.createdAt.getTime(),
		summary,
	};
	return run.finishedAt === null ? base : { ...base, finishedAt: run.finishedAt.getTime() };
};

/** Encode one RunRecord as an eval_run_record insert row — the
 * indexed columns (stage/engine/model/startedAt) are projections of
 * the payload so queries can slice without parsing JSON; `payload`
 * keeps the FULL record for audit. `itemId` is a soft reference to
 * eval_instance_item (plain integer, no FK — the record outlives
 * corpus edits the same way run.params does). */
export const runRecordRow = (
	record: RunRecord,
	fields: { readonly runId: number; readonly itemId: number },
): typeof evalRunRecord.$inferInsert => ({
	runId: fields.runId,
	itemId: fields.itemId,
	stage: record.stage,
	engine: record.engine,
	model: record.model ?? null,
	startedAt: record.startedAt,
	payload: JSON.stringify(record),
});

/** All records of one finished/failed sample as insert rows. */
export const runRecordRows = (
	records: readonly RunRecord[],
	fields: { readonly runId: number; readonly itemId: number },
): (typeof evalRunRecord.$inferInsert)[] => records.map((r) => runRecordRow(r, fields));

/** Decode an eval_run_record row back to its RunRecord — the
 * payload IS the record; the projected columns are ignored on the
 * way back (they exist for indexing, not as a second source of
 * truth). A corrupt payload throws — callers reading audit rows
 * should treat that as data corruption, not degrade silently. */
export const runRecordFromRow = (row: EvalRunRecord): RunRecord =>
	JSON.parse(row.payload) as RunRecord;
