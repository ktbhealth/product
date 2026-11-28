import { describe, expect, it } from "vitest";

import type { RunRecord } from "@ktb/eval-core";

import {
	datasetPinFor,
	runRecordFromRow,
	runRecordRow,
	runRecordRows,
	runToExperiment,
} from "./core-map.ts";
import type { EvalRun, EvalRunRecord } from "./schema.ts";

const runRow = (over: Partial<EvalRun> = {}): EvalRun => ({
	id: 7,
	instanceId: 3,
	params: JSON.stringify({ instanceId: 3, itemIds: [11, 12] }),
	status: "done",
	total: 2,
	done: 2,
	summary: JSON.stringify({ ok: 2, failed: 0, meanWer: 0.1 }),
	experiment: null,
	startedAt: new Date(1_700_000_000_000),
	finishedAt: new Date(1_700_000_060_000),
	leaseUntil: null,
	createdBy: "v@x.com",
	createdAt: new Date(1_699_999_999_000),
	...over,
});

const record: RunRecord = {
	runId: "eval-11",
	taskId: "eval-11",
	stage: "asr",
	engine: "whisper",
	model: "large-v3",
	inputHash: "h",
	startedAt: 123,
	sampleId: "11",
};

describe("datasetPinFor", () => {
	it("parses id+version out of a stored manifest", () => {
		const manifest = JSON.stringify({
			id: "eval-instance-3",
			version: "v2-deadbeef",
			domain: "eval.consultation",
		});
		expect(datasetPinFor(manifest, 3)).toEqual({
			id: "eval-instance-3",
			version: "v2-deadbeef",
		});
	});

	it("falls back on null, malformed JSON, and wrong shapes", () => {
		expect(datasetPinFor(null, 3)).toEqual({
			id: "eval-instance-3",
			version: "unknown",
		});
		expect(datasetPinFor("{broken", 3)).toEqual({
			id: "eval-instance-3",
			version: "unknown",
		});
		expect(datasetPinFor(JSON.stringify({ id: "x" }), 3)).toEqual({
			id: "eval-instance-3",
			version: "unknown",
		});
		// No instance id at all → still a deterministic pin.
		expect(datasetPinFor(null, null)).toEqual({
			id: "eval-instance-unknown",
			version: "unknown",
		});
	});
});

describe("runToExperiment", () => {
	it("maps a finished run onto an Experiment with no gates", () => {
		const pin = { id: "eval-instance-3", version: "v2-deadbeef" };
		const exp = runToExperiment(runRow(), [], pin);
		expect(exp.id).toBe("eval-run-7");
		expect(exp.kind).toBe("run");
		expect(exp.suiteId).toBe("eval.consultation");
		expect(exp.profile).toBe("platform");
		expect(exp.dataset).toEqual(pin);
		expect(exp.startedAt).toBe(1_700_000_000_000);
		expect(exp.finishedAt).toBe(1_700_000_060_000);
		expect(exp.summary).toEqual({ ok: 2, failed: 0, meanWer: 0.1 });
		expect(exp.manifestHash).toMatch(/^[0-9a-f]{8}$/);
		expect(exp.gates).toBeUndefined();
	});

	it("manifestHash is stable for identical inputs+pin, differs otherwise", () => {
		const pin = { id: "d", version: "v1" };
		const a = runToExperiment(runRow(), [], pin);
		const b = runToExperiment(runRow(), [], pin);
		const c = runToExperiment(runRow({ params: "{}" }), [], pin);
		expect(a.manifestHash).toBe(b.manifestHash);
		expect(a.manifestHash).not.toBe(c.manifestHash);
	});

	it("omits finishedAt while running and falls back to createdAt", () => {
		const exp = runToExperiment(
			runRow({ startedAt: null, finishedAt: null, status: "running" }),
			[],
			{ id: "d", version: "v1" },
		);
		expect(exp.finishedAt).toBeUndefined();
		expect(exp.startedAt).toBe(1_699_999_999_000);
	});

	it("degrades malformed summary JSON to {}", () => {
		const exp = runToExperiment(runRow({ summary: "{oops" }), [], {
			id: "d",
			version: "v1",
		});
		expect(exp.summary).toEqual({});
		const arr = runToExperiment(runRow({ summary: "[1,2]" }), [], { id: "d", version: "v1" });
		expect(arr.summary).toEqual({});
	});
});

describe("run record codec", () => {
	it("encodes a RunRecord into projected columns + full payload", () => {
		const row = runRecordRow(record, { runId: 7, itemId: 11 });
		expect(row.runId).toBe(7);
		expect(row.itemId).toBe(11);
		expect(row.stage).toBe("asr");
		expect(row.engine).toBe("whisper");
		expect(row.model).toBe("large-v3");
		expect(row.startedAt).toBe(123);
		expect(JSON.parse(row.payload)).toMatchObject({ stage: "asr", sampleId: "11" });
	});

	it("maps a batch and decodes a stored row back to the record", () => {
		const rows = runRecordRows([record, { ...record, stage: "tts", model: undefined }], {
			runId: 7,
			itemId: 11,
		});
		expect(rows).toHaveLength(2);
		expect(rows[1]?.model).toBeNull();
		const stored = {
			id: 1,
			runId: 7,
			itemId: 11,
			stage: "asr",
			engine: "whisper",
			model: "large-v3",
			startedAt: 123,
			payload: JSON.stringify(record),
		} as EvalRunRecord;
		expect(runRecordFromRow(stored)).toEqual(record);
	});
});
