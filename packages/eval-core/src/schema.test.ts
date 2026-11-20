import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	BlobMeta,
	CalibrationBucket,
	CalibrationJudge,
	CalibrationKindStat,
	CalibrationReport,
	ConfSegment,
	DatasetManifest,
	DatasetPin,
	EditList,
	EditOp,
	EvalAnswer,
	EvalQuestion,
	Experiment,
	ExperimentGate,
	PromptRef,
	RunRecord,
} from "./schema.ts";

const dec = Schema.decodeUnknownSync;
const bad =
	<S extends Parameters<typeof Schema.decodeUnknownSync>[0]>(schema: S) =>
	(input: unknown) =>
		expect(() => dec(schema)(input)).toThrowError(Schema.SchemaError);

describe("BlobMeta", () => {
	it("decodes each declared origin and rejects others", () => {
		const d = dec(BlobMeta);
		for (const origin of ["synthetic", "real_anonymized", "unknown"] as const) {
			expect(d({ origin }).origin).toBe(origin);
		}
		bad(BlobMeta)({ origin: "bogus" });
		bad(BlobMeta)({});
		bad(BlobMeta)(null);
	});
});

describe("EvalQuestion", () => {
	it("decodes all question kinds and optional fields", () => {
		const d = dec(EvalQuestion);
		expect(d({ id: "q1", kind: "noul", text: "t" })).toEqual({
			id: "q1",
			kind: "noul",
			text: "t",
		});
		expect(d({ id: "q2", kind: "choice", text: "t", options: ["a", "b"] })).toMatchObject({
			kind: "choice",
			options: ["a", "b"],
		});
		expect(d({ id: "q3", kind: "score", text: "t", maxScore: 5 })).toMatchObject({
			kind: "score",
			maxScore: 5,
		});
		bad(EvalQuestion)({ id: "q", kind: "bogus", text: "t" });
		bad(EvalQuestion)({ id: "q", kind: "noul" });
		bad(EvalQuestion)(null);
	});
});

describe("EvalAnswer", () => {
	it("decodes boolean/string/number values and rejects bad kinds", () => {
		const d = dec(EvalAnswer);
		expect(d({ id: "q", kind: "noul", value: true, probability: 0.9 }).value).toBe(true);
		expect(d({ id: "q", kind: "choice", value: "a", probability: 0.5 }).value).toBe("a");
		expect(d({ id: "q", kind: "score", value: 3, probability: 0.7 }).value).toBe(3);
		bad(EvalAnswer)({ id: "q", kind: "bogus", value: true, probability: 0.9 });
		bad(EvalAnswer)({ id: "q", kind: "noul", probability: 0.9 });
		bad(EvalAnswer)({ id: "q", kind: "noul", value: null, probability: 0.9 });
	});
});

describe("PromptRef", () => {
	it("decodes name with optional string-or-number version and hash", () => {
		const d = dec(PromptRef);
		expect(d({ name: "cleanup" })).toEqual({ name: "cleanup" });
		expect(d({ name: "cleanup", version: "v2" }).version).toBe("v2");
		expect(d({ name: "cleanup", version: 3 }).version).toBe(3);
		expect(d({ name: "cleanup", hash: "abc" }).hash).toBe("abc");
		bad(PromptRef)({ name: "x", version: true });
		bad(PromptRef)({});
	});
});

describe("RunRecord", () => {
	const base = {
		runId: "r1",
		taskId: "t1",
		stage: "asr",
		engine: "eng",
		inputHash: "h",
		startedAt: 0,
	};

	it("decodes a minimal record and preserves optional fields", () => {
		const d = dec(RunRecord);
		expect(d(base)).toEqual(base);
		const full = d({
			...base,
			model: "m",
			engineVersion: "ev",
			seed: 7,
			latencyMs: 12,
			sampleId: "s",
			datasetVersion: "dv",
			estCostUsd: 0.01,
			parents: ["p1", "p2"],
			branch: "b",
			prompt: { name: "n", version: 1, hash: "hh" },
		});
		expect(full.model).toBe("m");
		expect(full.parents).toEqual(["p1", "p2"]);
		expect(full.prompt).toEqual({ name: "n", version: 1, hash: "hh" });
	});

	it("rejects records missing required fields", () => {
		for (const key of ["runId", "taskId", "stage", "engine", "inputHash", "startedAt"] as const) {
			const { [key]: _omit, ...rest } = base;
			bad(RunRecord)(rest);
		}
		bad(RunRecord)({ ...base, parents: "not-an-array" });
		bad(RunRecord)({ ...base, prompt: { version: 1 } });
	});
});

describe("EditOp / EditList", () => {
	it("decodes each op kind and rejects unknown kinds", () => {
		const d = dec(EditOp);
		for (const kind of ["fix", "punct", "entity", "format"] as const) {
			expect(d({ at: 0, remove: "a", insert: "b", kind }).kind).toBe(kind);
		}
		expect(d({ at: 0, remove: "a", insert: "b", kind: "fix", flagged: true }).flagged).toBe(true);
		bad(EditOp)({ at: 0, remove: "a", insert: "b", kind: "bogus" });
		bad(EditOp)({ at: 0, remove: "a", insert: "b" });
		bad(EditOp)({ remove: "a", insert: "b", kind: "fix" });
	});

	it("EditList decodes an ops array", () => {
		const d = dec(EditList);
		const list = d({ ops: [{ at: 1, remove: "x", insert: "y", kind: "fix" }] });
		expect(list.ops).toHaveLength(1);
		expect(list.ops[0]?.insert).toBe("y");
		bad(EditList)({ ops: "nope" });
		bad(EditList)({});
	});
});

describe("ConfSegment", () => {
	it("decodes correct flag with optional confidence", () => {
		const d = dec(ConfSegment);
		expect(d({ correct: true })).toEqual({ correct: true });
		expect(d({ correct: false, confidence: 0.5 }).confidence).toBe(0.5);
		bad(ConfSegment)({ confidence: 0.5 });
		bad(ConfSegment)({ correct: "yes" });
	});
});

describe("market-parity artifacts", () => {
	it("DatasetPin decodes id+version only", () => {
		const d = dec(DatasetPin);
		expect(d({ id: "d", version: "v1" })).toEqual({ id: "d", version: "v1" });
		bad(DatasetPin)({ id: "d" });
		bad(DatasetPin)({ version: "v1" });
	});

	it("ExperimentGate decodes verdict counts", () => {
		const d = dec(ExperimentGate);
		expect(d({ id: "g", green: true, accepted: 3, total: 4 })).toEqual({
			id: "g",
			green: true,
			accepted: 3,
			total: 4,
		});
		bad(ExperimentGate)({ id: "g", green: true, accepted: 3 });
		bad(ExperimentGate)({ id: "g", green: "yes", accepted: 3, total: 4 });
	});

	it("Experiment decodes both kinds and rejects bad ones", () => {
		const d = dec(Experiment);
		const base = {
			id: "e1",
			suiteId: "s",
			manifestHash: "h",
			profile: "p",
			dataset: { id: "d", version: "v" },
			startedAt: 1,
			summary: { k: 1 },
		};
		expect(d({ ...base, kind: "generate" }).kind).toBe("generate");
		expect(d({ ...base, kind: "run" }).kind).toBe("run");
		const full = d({
			...base,
			kind: "run",
			gitSha: "abc",
			finishedAt: 2,
			gates: [{ id: "g", green: false, accepted: 0, total: 1 }],
			derivedFrom: ["r1"],
		});
		expect(full.gitSha).toBe("abc");
		expect(full.derivedFrom).toEqual(["r1"]);
		bad(Experiment)({ ...base, kind: "bogus" });
		bad(Experiment)({ ...base, kind: "run", summary: "not-an-object" });
		bad(Experiment)({ ...base, kind: "run", dataset: { id: "d" } });
	});

	it("DatasetManifest decodes registry fields", () => {
		const d = dec(DatasetManifest);
		const m = {
			id: "d",
			version: "v1",
			domain: "dom",
			generator: { seed: 1 },
			createdAt: 1,
			sampleCount: 3,
			contentHash: "abc",
		};
		expect(d(m).contentHash).toBe("abc");
		expect(d({ ...m, provenance: { by: "t" } }).provenance).toEqual({ by: "t" });
		bad(DatasetManifest)({ ...m, sampleCount: "x" });
		bad(DatasetManifest)({ ...m, generator: 42 });
	});

	it("CalibrationKindStat / CalibrationBucket / CalibrationJudge decode", () => {
		expect(
			dec(CalibrationKindStat)({ kind: "noul", n: 5, agreements: 4, agreementRate: 0.8 }),
		).toEqual({ kind: "noul", n: 5, agreements: 4, agreementRate: 0.8 });
		bad(CalibrationKindStat)({ kind: "noul", n: 5, agreements: 4 });

		expect(
			dec(CalibrationBucket)({ lo: 0.9, hi: 0.95, count: 2, agreements: 2, agreementRate: 1 }),
		).toEqual({ lo: 0.9, hi: 0.95, count: 2, agreements: 2, agreementRate: 1 });
		bad(CalibrationBucket)({ lo: 0.9, hi: 0.95, count: 2, agreements: 2 });

		expect(dec(CalibrationJudge)({ engine: "jev" })).toEqual({ engine: "jev" });
		expect(dec(CalibrationJudge)({ engine: "jev", model: "m" }).model).toBe("m");
		bad(CalibrationJudge)({ model: "m" });
	});

	it("CalibrationReport decodes the full report", () => {
		const d = dec(CalibrationReport);
		const r = {
			id: "c1",
			suiteId: "s",
			dataset: { id: "d", version: "v" },
			createdAt: 1,
			samples: 0,
			questions: 0,
			agreements: 0,
			agreementRate: 0,
			lowerBound: 0,
			kinds: [],
			buckets: [],
			judges: [],
		};
		expect(d(r).id).toBe("c1");
		const full = d({
			...r,
			runId: "run-1",
			kinds: [{ kind: "noul", n: 1, agreements: 1, agreementRate: 1 }],
			judges: [{ engine: "jev", model: "m" }],
		});
		expect(full.runId).toBe("run-1");
		expect(full.kinds[0]?.kind).toBe("noul");
		bad(CalibrationReport)({ ...r, questions: "x" });
		bad(CalibrationReport)({ ...r, kinds: "nope" });
		bad(CalibrationReport)({ ...r, dataset: { id: "d" } });
	});
});
