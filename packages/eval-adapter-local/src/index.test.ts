import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, describe, expect, it } from "vitest";

import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { EvalStorePort, PortError, ReportPort, type RunRecord } from "@ktb/eval-core";
import {
	AsrPort,
	DatasetStorePort,
	EvalArtifacts,
	EvalRunner,
	LlmPort,
	TtsPort,
	type Sample,
} from "@ktb/eval-consultation";

import {
	evalArtifactsLocalDriver,
	evalRunnerLocalDriver,
	makeEvalRunner,
	makeLocalEvalStoreLayer,
	makeLocalReportLayer,
	makeLocalStoreLayer,
} from "./index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-local-"));
const reportPath = path.join(root, "reports", "run.jsonl");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const sample: Sample = {
	id: "s1",
	datasetVersion: "v1",
	origin: "synthetic",
	script: "script text",
	scriptHash: "h",
	persona: {
		region: "southeast",
		ageBand: "adult",
		register: "formal",
		specialty: "general_practice",
	},
	audio: { uri: "stub://audio/1" },
	gold: { validatedBy: "generator" },
};

const record: RunRecord = {
	runId: "run-1",
	taskId: "task-1",
	stage: "asr",
	engine: "test",
	model: "m1",
	inputHash: "h",
	latencyMs: 42,
	estCostUsd: 0.001,
	startedAt: 0,
};

describe("local store layer", () => {
	it("putSample/getSample/listSamples round-trip", async () => {
		const layer = makeLocalStoreLayer(root);
		const run = <A>(e: Effect.Effect<A, unknown, DatasetStorePort>) =>
			Effect.runPromise(Effect.provide(e, layer));

		await run(
			Effect.gen(function* () {
				const store = yield* DatasetStorePort;
				yield* store.putSample(sample);
			}),
		);

		const got = await run(
			Effect.gen(function* () {
				const store = yield* DatasetStorePort;
				return yield* store.getSample("s1");
			}),
		);
		expect(got).toEqual(sample);

		const listed = await run(
			Effect.gen(function* () {
				const store = yield* DatasetStorePort;
				return yield* store.listSamples({ origin: "synthetic" });
			}),
		);
		expect(listed.map((s) => s.id)).toEqual(["s1"]);

		const filteredOut = await run(
			Effect.gen(function* () {
				const store = yield* DatasetStorePort;
				return yield* store.listSamples({ origin: "real_anonymized" });
			}),
		);
		expect(filteredOut).toHaveLength(0);
	});

	it("blob put/get round-trip + missing → null", async () => {
		const layer = makeLocalStoreLayer(root);
		const bytes = new Uint8Array([1, 2, 3]);
		const run = <A>(e: Effect.Effect<A, unknown, DatasetStorePort>) =>
			Effect.runPromise(Effect.provide(e, layer));
		const r = await run(
			Effect.gen(function* () {
				const store = yield* DatasetStorePort;
				yield* store.putBlob("audio/x", bytes);
				return yield* store.getBlob("audio/x");
			}),
		);
		expect(r).toEqual(bytes);

		const missing = await run(
			Effect.gen(function* () {
				const store = yield* DatasetStorePort;
				return yield* store.getBlob("nope");
			}),
		);
		expect(missing).toBeNull();
	});

	it("blob provenance round-trips; missing meta defaults to unknown", async () => {
		const layer = makeLocalStoreLayer(root);
		const run = <A>(e: Effect.Effect<A, unknown, DatasetStorePort>) =>
			Effect.runPromise(Effect.provide(e, layer));
		const r = await run(
			Effect.gen(function* () {
				const s = yield* DatasetStorePort;
				yield* s.putBlob("prov/syn", new Uint8Array([1]), { origin: "synthetic" });
				yield* s.putBlob("prov/real", new Uint8Array([2]), { origin: "real_anonymized" });
				yield* s.putBlob("prov/none", new Uint8Array([3]));
				return {
					syn: yield* s.getBlobMeta("prov/syn"),
					real: yield* s.getBlobMeta("prov/real"),
					none: yield* s.getBlobMeta("prov/none"),
					missing: yield* s.getBlobMeta("prov/missing"),
				};
			}),
		);
		expect(r.syn).toEqual({ origin: "synthetic" });
		expect(r.real).toEqual({ origin: "real_anonymized" });
		expect(r.none).toEqual({ origin: "unknown" });
		expect(r.missing).toBeNull();
	});

	it("putBlobMeta records provenance without bytes (M1)", async () => {
		const layer = makeLocalStoreLayer(root);
		const run = <A>(e: Effect.Effect<A, unknown, DatasetStorePort>) =>
			Effect.runPromise(Effect.provide(e, layer));
		const r = await run(
			Effect.gen(function* () {
				const s = yield* DatasetStorePort;
				yield* s.putBlobMeta("meta/tts.wav", { origin: "synthetic" });
				yield* s.putBlobMeta("meta/undeclared.wav");
				return {
					meta: yield* s.getBlobMeta("meta/tts.wav"),
					def: yield* s.getBlobMeta("meta/undeclared.wav"),
					// Meta-only registration writes no blob bytes.
					blob: yield* s.getBlob("meta/tts.wav"),
				};
			}),
		);
		expect(r.meta).toEqual({ origin: "synthetic" });
		expect(r.def).toEqual({ origin: "unknown" });
		expect(r.blob).toBeNull();
	});

	it("putBlobMeta rejects a bogus origin on write", async () => {
		const layer = makeLocalStoreLayer(root);
		const err = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* DatasetStorePort;
					yield* s.putBlobMeta("meta/bad", { origin: "bogus" as never });
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				layer,
			),
		);
		expect(String(err)).toContain("putBlobMeta");
	});

	it("putBlob rejects a bogus origin on write", async () => {
		const layer = makeLocalStoreLayer(root);
		const err = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* DatasetStorePort;
					yield* s.putBlob("prov/bad", new Uint8Array([1]), {
						origin: "bogus" as never,
					});
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				layer,
			),
		);
		expect(String(err)).toContain("putBlob");
	});

	it("getBlobMeta fails typed on a corrupt meta row", async () => {
		const layer = makeLocalStoreLayer(root);
		// Plant a corrupt provenance row directly — reads must surface
		// it as a PortError, never a silent null.
		const Database = (await import("better-sqlite3")).default;
		const db = new Database(path.join(root, "manifest.sqlite"));
		db.exec(`CREATE TABLE IF NOT EXISTS blob_meta (uri TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
		db.prepare(`INSERT INTO blob_meta (uri, doc) VALUES (?, ?)`).run(
			"prov/corrupt",
			'{"origin":42}',
		);
		db.close();
		const err = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* DatasetStorePort;
					return yield* s.getBlobMeta("prov/corrupt");
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				layer,
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).message).toContain("getBlobMeta");
	});

	it("putResult/listResults round-trip", async () => {
		const layer = makeLocalStoreLayer(root);
		const run = <A>(e: Effect.Effect<A, unknown, DatasetStorePort>) =>
			Effect.runPromise(Effect.provide(e, layer));
		const result = {
			runId: "r1",
			sampleId: "s1",
			datasetVersion: "v1",
			asrText: "raw",
			correctedText: "fixed",
			editVerdicts: [{ editIndex: 0, classification: "unjudged" as const }],
			confSegments: [{ confidence: 0.9, correct: true }],
			createdAt: 1,
		};
		const got = await run(
			Effect.gen(function* () {
				const s = yield* DatasetStorePort;
				yield* s.putResult(result);
				return yield* s.listResults({ sampleId: "s1" });
			}),
		);
		expect(got).toHaveLength(1);
		expect(got[0]?.asrText).toBe("raw");
		expect(got[0]?.editVerdicts[0]?.classification).toBe("unjudged");

		const byRun = await run(
			Effect.gen(function* () {
				const s = yield* DatasetStorePort;
				return yield* s.listResults({ runId: "other" });
			}),
		);
		expect(byRun).toHaveLength(0);
	});

	it("LGPD gate: real_anonymized without provenance is rejected", async () => {
		const layer = makeLocalStoreLayer(root);
		const err = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* DatasetStorePort;
					yield* s.putSample({
						...sample,
						id: "bad-1",
						origin: "real_anonymized",
					});
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				layer,
			),
		);
		expect(String(err)).toContain("provenance");
	});

	it("getBlob surfaces non-ENOENT fs errors instead of null", async () => {
		const layer = makeLocalStoreLayer(root);
		// Plant a directory where the blob file would live — readFileSync
		// then fails with EISDIR, which must NOT masquerade as "missing".
		const { createHash } = await import("node:crypto");
		const blobDir = path.join(root, "blobs", createHash("sha256").update("dir-uri").digest("hex"));
		fs.mkdirSync(blobDir, { recursive: true });
		const err = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* DatasetStorePort;
					return yield* s.getBlob("dir-uri");
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				layer,
			),
		);
		expect(String(err)).toContain("getBlob");
	});

	it("putResult rejects a malformed result on write", async () => {
		const layer = makeLocalStoreLayer(root);
		const err = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* DatasetStorePort;
					yield* s.putResult({ runId: "r" } as never);
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				layer,
			),
		);
		expect(String(err)).toContain("putResult");
	});
});

describe("local report layer", () => {
	it("append + render markdown", async () => {
		const layer = makeLocalReportLayer(reportPath);
		const md = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const report = yield* ReportPort;
					yield* report.append(record);
					yield* report.append({ ...record, runId: "other" });
					return yield* report.render("run-1");
				}),
				layer,
			),
		);
		expect(md).toContain("run-1");
		expect(md).toContain("| asr | test | m1 | 42 | 0.001 |");
		expect(md).not.toContain("| asr | test | m1 | 42 | 0.001 |\n| asr | test | m1 | 42 | 0.001 |");
	});

	it("render with no file → empty report", async () => {
		const layer = makeLocalReportLayer(path.join(root, "nope.jsonl"));
		const md = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const report = yield* ReportPort;
					return yield* report.render("none");
				}),
				layer,
			),
		);
		expect(md).toContain("no records");
	});
});

describe("branch coverage", () => {
	it("listSamples/listResults without filters return everything", async () => {
		const layer = makeLocalStoreLayer(root);
		const run = <A>(e: Effect.Effect<A, unknown, DatasetStorePort>) =>
			Effect.runPromise(Effect.provide(e, layer));
		const all = await run(
			Effect.gen(function* () {
				const s = yield* DatasetStorePort;
				return {
					samples: yield* s.listSamples(),
					results: yield* s.listResults(),
				};
			}),
		);
		expect(all.samples.length).toBeGreaterThan(0);
		expect(all.results.length).toBeGreaterThan(0);
	});

	it("render prints '-' for missing optional fields", async () => {
		const p = path.join(root, "reports", "sparse.jsonl");
		const layer = makeLocalReportLayer(p);
		const md = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const r = yield* ReportPort;
					yield* r.append({
						runId: "sparse-run",
						taskId: "t",
						stage: "s",
						engine: "e",
						inputHash: "h",
						startedAt: 0,
					});
					return yield* r.render("sparse-run");
				}),
				layer,
			),
		);
		expect(md).toContain("| - | s | e | - | - | - |");
	});

	it("render drops a torn trailing line (crash mid-append)", async () => {
		const p = path.join(root, "reports", "torn.jsonl");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, `${JSON.stringify({ ...record, runId: "torn-run" })}\n{"runId":"tor`);
		const layer = makeLocalReportLayer(p);
		const md = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const r = yield* ReportPort;
					return yield* r.render("torn-run");
				}),
				layer,
			),
		);
		expect(md).toContain("| asr | test | m1 | 42 | 0.001 |");
	});

	it("render on a whitespace-only file → empty report", async () => {
		const p = path.join(root, "reports", "blank.jsonl");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "\n  \n");
		const layer = makeLocalReportLayer(p);
		const md = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const r = yield* ReportPort;
					return yield* r.render("blank-run");
				}),
				layer,
			),
		);
		expect(md).toContain("no records");
	});

	it("render still fails on a corrupt MIDDLE line", async () => {
		const p = path.join(root, "reports", "corrupt.jsonl");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, `{"bad\n${JSON.stringify({ ...record, runId: "corrupt-run" })}\n`);
		const layer = makeLocalReportLayer(p);
		const err = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const r = yield* ReportPort;
					return yield* r.render("corrupt-run");
				}),
				layer,
			),
		).then(
			() => null,
			(e) => e,
		);
		expect(err).toBeInstanceOf(PortError);
	});
});

describe("crash debris sweep", () => {
	it("removes stale .tmp files, keeps fresh ones and real blobs", async () => {
		const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eval-sweep-"));
		const blobs = path.join(sweepRoot, "blobs");
		fs.mkdirSync(blobs, { recursive: true });
		const stale = path.join(blobs, "abc.tmp-1234");
		const fresh = path.join(blobs, "def.tmp-5678");
		const blob = path.join(blobs, "realblob");
		fs.writeFileSync(stale, "x");
		fs.writeFileSync(fresh, "x");
		fs.writeFileSync(blob, "x");
		// Backdate the stale one past the freshness window.
		const old = new Date(Date.now() - 120_000);
		fs.utimesSync(stale, old, old);
		// A dangling symlink named like a tmp: statSync throws ENOENT
		// → exercises the vanished-between-readdir-and-stat catch.
		fs.symlinkSync(path.join(blobs, "does-not-exist"), path.join(blobs, "ghost.tmp-9"));

		await Effect.runPromise(
			Effect.scoped(
				Effect.provide(
					Effect.gen(function* () {
						const s = yield* DatasetStorePort;
						yield* s.putBlob("probe", new Uint8Array([1]));
					}),
					makeLocalStoreLayer(sweepRoot),
				),
			),
		);
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
		expect(fs.existsSync(blob)).toBe(true);
		fs.rmSync(sweepRoot, { recursive: true, force: true });
	});
});

it("getSample returns null for unknown ids", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* DatasetStorePort;
					expect(yield* s.getSample("nope")).toBeNull();
				}),
				makeLocalStoreLayer(root),
			),
		),
	);
});

describe("local eval store (P-076)", () => {
	const evalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eval-store-"));
	const run = <A>(e: Effect.Effect<A, unknown, EvalStorePort>) =>
		Effect.runPromise(Effect.provide(e, makeLocalEvalStoreLayer(evalRoot)));

	const experiment = {
		id: "run-1",
		kind: "run" as const,
		suiteId: "s1",
		manifestHash: "h",
		profile: "stub",
		dataset: { id: "d", version: "v1" },
		startedAt: 1,
		summary: { ok: 2 },
	};
	const datasetManifest = {
		id: "d",
		version: "v1",
		domain: "dom",
		generator: { seed: 7 },
		createdAt: 1,
		sampleCount: 2,
		contentHash: "hash-a",
	};
	const calibration = {
		id: "cal-1",
		suiteId: "s1",
		dataset: { id: "d", version: "v1" },
		runId: "run-1",
		createdAt: 1,
		samples: 1,
		questions: 4,
		agreements: 3,
		agreementRate: 0.75,
		lowerBound: 0.3,
		kinds: [],
		buckets: [],
		judges: [],
	};

	it("experiments round-trip + suiteId filter", async () => {
		await run(
			Effect.gen(function* () {
				const s = yield* EvalStorePort;
				yield* s.putExperiment(experiment);
				yield* s.putExperiment({ ...experiment, id: "run-2", suiteId: "s2" });
				expect((yield* s.getExperiment("run-1"))?.id).toBe("run-1");
				expect(yield* s.getExperiment("nope")).toBeNull();
				expect((yield* s.listExperiments()).length).toBe(2);
				expect((yield* s.listExperiments({ suiteId: "s2" })).map((e) => e.id)).toEqual(["run-2"]);
				expect(yield* s.listExperiments({ suiteId: "ghost" })).toEqual([]);
			}),
		);
	});

	it("dataset manifests: insert, idempotent same-hash, conflict on diff hash", async () => {
		await run(
			Effect.gen(function* () {
				const s = yield* EvalStorePort;
				yield* s.putDatasetManifest(datasetManifest);
				// Same contentHash → idempotent no-op (original doc kept).
				yield* s.putDatasetManifest({ ...datasetManifest, createdAt: 2 });
				const got = yield* s.getDatasetManifest("d", "v1");
				expect(got?.contentHash).toBe("hash-a");
				expect(got?.createdAt).toBe(1);
				expect(yield* s.getDatasetManifest("d", "vX")).toBeNull();
				expect((yield* s.listDatasetManifests()).length).toBe(1);
				const err = yield* Effect.flip(
					s.putDatasetManifest({ ...datasetManifest, contentHash: "hash-b" }),
				);
				expect(String(err)).toContain("already registered");
			}),
		);
	});

	it("calibration reports round-trip + filters", async () => {
		await run(
			Effect.gen(function* () {
				const s = yield* EvalStorePort;
				yield* s.putCalibrationReport(calibration);
				yield* s.putCalibrationReport({
					...calibration,
					id: "cal-2",
					suiteId: "s2",
					runId: "run-2",
				});
				expect((yield* s.listCalibrationReports()).length).toBe(2);
				expect(
					(yield* s.listCalibrationReports({ suiteId: "s1", runId: "run-1" })).map((c) => c.id),
				).toEqual(["cal-1"]);
				expect((yield* s.listCalibrationReports({ runId: "run-1" })).map((c) => c.id)).toEqual([
					"cal-1",
				]);
				expect(yield* s.listCalibrationReports({ suiteId: "ghost" })).toEqual([]);
				expect(yield* s.listCalibrationReports({ runId: "ghost" })).toEqual([]);
			}),
		);
	});

	it("write-side schema decode rejects malformed artifacts", async () => {
		const err = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* EvalStorePort;
					yield* s.putExperiment({ id: "bad" } as never);
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				makeLocalEvalStoreLayer(evalRoot),
			),
		);
		expect(String(err)).toContain("putExperiment");
		const err2 = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* EvalStorePort;
					yield* s.putDatasetManifest({ id: "x" } as never);
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				makeLocalEvalStoreLayer(evalRoot),
			),
		);
		expect(String(err2)).toContain("putDatasetManifest");
		const err3 = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const s = yield* EvalStorePort;
					yield* s.putCalibrationReport({ id: "bad" } as never);
				}).pipe(Effect.catchTag("PortError", (e) => Effect.succeed(e))),
				makeLocalEvalStoreLayer(evalRoot),
			),
		);
		expect(String(err3)).toContain("putCalibrationReport");
	});
});

describe("evalRunnerLocalDriver", () => {
	it("is eligible only with artifact dir + asr base url", () => {
		expect(evalRunnerLocalDriver.when?.({}) ?? true).toBe(false);
		expect(evalRunnerLocalDriver.when?.({ EVAL_RUNNER_DIR: "/x" }) ?? true).toBe(false);
		expect(
			evalRunnerLocalDriver.when?.({
				EVAL_RUNNER_DIR: "/x",
				EVAL_ASR_BASE_URL: "http://asr",
			}) ?? false,
		).toBe(true);
	});

	it("runs items through tts → asr → wer and reports ok outcomes", async () => {
		const ports = Layer.mergeAll(
			Layer.succeed(
				TtsPort,
				TtsPort.of({
					synthesize: () =>
						Effect.succeed({
							audio: { uri: "file:///work/tts/audio/a.wav" },
							record,
						}),
				}),
			),
			Layer.succeed(
				AsrPort,
				AsrPort.of({
					transcribe: () => Effect.succeed({ asr: { text: "hello world", segments: [] }, record }),
				}),
			),
		);
		const layer = makeEvalRunner(ports);
		const outcomes: { id: number | string; status: string; result?: unknown; error?: string }[] =
			[];
		await Effect.runPromise(
			Effect.flatMap(EvalRunner, (r) =>
				r.run({
					runId: "r1",
					items: [
						{ id: 1, script: "hello world", voices: { patient: "br_female_1" } },
						{ id: 2, script: "hello there", turns: [{ speaker: "p", text: "hi" }] },
					],
					onSample: (id, outcome) =>
						Effect.sync(() => {
							outcomes.push({
								id,
								status: outcome.status,
								result: outcome.result,
								error: outcome.error,
							});
						}),
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(outcomes.map((o) => o.status)).toEqual(["ok", "ok"]);
		const first = outcomes[0]!.result as { audioUri: string; asrText: string; wer: number };
		expect(first.audioUri).toBe("file:///work/tts/audio/a.wav");
		expect(first.asrText).toBe("hello world");
		expect(first.wer).toBe(0);
	});

	const ttsAsrPorts = (asrText = "hello wrld") =>
		Layer.mergeAll(
			Layer.succeed(
				TtsPort,
				TtsPort.of({
					synthesize: () =>
						Effect.succeed({
							audio: { uri: "file:///work/tts/audio/a.wav" },
							record,
						}),
				}),
			),
			Layer.succeed(
				AsrPort,
				AsrPort.of({
					transcribe: () => Effect.succeed({ asr: { text: asrText, segments: [] }, record }),
				}),
			),
		);

	const runItems = (
		items: readonly { id: number; script: string; patient?: { sex?: string; age?: number } }[],
		ambient: Layer.Layer<never>,
	) => {
		const outcomes: { status: string; result?: unknown }[] = [];
		return Effect.flatMap(EvalRunner, (r) =>
			r.run({
				runId: "r1",
				items,
				onSample: (_id, outcome) =>
					Effect.sync(() => {
						outcomes.push({ status: outcome.status, result: outcome.result });
					}),
			}),
		)
			.pipe(Effect.provide(makeEvalRunner(ttsAsrPorts())), Effect.provide(ambient))
			.pipe(Effect.andThen(Effect.succeed(outcomes)));
	};

	it("runs cleanup + anamnesis when the ambient ports are bound", async () => {
		const ambient = Layer.mergeAll(
			Layer.succeed(
				LlmPort,
				LlmPort.of({
					generate: () => Effect.succeed({ text: "", record }),
					correct: () =>
						Effect.succeed({
							edits: { ops: [{ at: 6, remove: "wrld", insert: "world", kind: "fix" }] },
							record,
						}),
				}),
			),
			Layer.succeed(
				AnamnesisEngine,
				AnamnesisEngine.of({
					extract: () =>
						Effect.succeed({
							anamnesis: {
								queixa_principal: { content: "dor", confidence: "alta", evidence: [] },
								hda: { content: "", confidence: "baixa", evidence: [] },
								antecedentes: { content: "", confidence: "baixa", evidence: [] },
								alergias: { content: "", confidence: "baixa", evidence: [] },
								medicamentos_em_uso: { content: "", confidence: "baixa", evidence: [] },
								exame_fisico: { content: "", confidence: "baixa", evidence: [] },
								hipoteses: { content: "", confidence: "baixa", evidence: [] },
								conduta: { content: "", confidence: "baixa", evidence: [] },
							},
							engine: "stub",
						}),
				}),
			),
		);
		const outcomes = await Effect.runPromise(
			runItems([{ id: 1, script: "hello world", patient: { sex: "female", age: 40 } }], ambient),
		);
		const r = outcomes[0]?.result as {
			stages: string[];
			cleanup: { edits: number; corrected: string; werAfter: number };
			anamnesis: { engine: string; filled: number; sections: number; completeness: number };
		};
		expect(r.stages).toEqual(["asr", "cleanup", "anamnesis"]);
		expect(r.cleanup.corrected).toBe("hello world");
		expect(r.cleanup.edits).toBe(1);
		expect(r.cleanup.werAfter).toBe(0);
		expect(r.anamnesis.engine).toBe("stub");
		expect(r.anamnesis.filled).toBe(1);
		expect(r.anamnesis.completeness).toBe(0.125);
	});

	it("skips both stages when no ambient ports are bound", async () => {
		const outcomes = await Effect.runPromise(
			runItems([{ id: 1, script: "hello world" }], Layer.empty),
		);
		const r = outcomes[0]?.result as { stages: string[]; cleanup?: unknown; anamnesis?: unknown };
		expect(r.stages).toEqual(["asr"]);
		expect(r.cleanup).toBeUndefined();
		expect(r.anamnesis).toBeUndefined();
	});

	it("records stage errors without failing the sample", async () => {
		const ambient = Layer.mergeAll(
			Layer.succeed(
				LlmPort,
				LlmPort.of({
					generate: () => Effect.succeed({ text: "", record }),
					correct: () => Effect.fail(new PortError({ port: "llm", message: "corrector down" })),
				}),
			),
			Layer.succeed(
				AnamnesisEngine,
				AnamnesisEngine.of({
					extract: () => Effect.fail(new Error("extract down") as never),
				}),
			),
		);
		const outcomes = await Effect.runPromise(runItems([{ id: 1, script: "hello world" }], ambient));
		expect(outcomes[0]?.status).toBe("ok");
		const r = outcomes[0]?.result as {
			cleanup: { error?: string };
			anamnesis: { error?: string };
		};
		expect(r.cleanup.error).toContain("corrector down");
		expect(r.anamnesis.error).toContain("extract down");
	});

	it("feeds the corrected transcript to the anamnesis stage", async () => {
		let seenTranscript = "";
		const ambient = Layer.mergeAll(
			Layer.succeed(
				LlmPort,
				LlmPort.of({
					generate: () => Effect.succeed({ text: "", record }),
					correct: () =>
						Effect.succeed({
							edits: { ops: [{ at: 6, remove: "wrld", insert: "world", kind: "fix" }] },
							record,
						}),
				}),
			),
			Layer.succeed(
				AnamnesisEngine,
				AnamnesisEngine.of({
					extract: (input) =>
						Effect.sync(() => {
							seenTranscript = input.transcript;
							return {
								anamnesis: {
									queixa_principal: { content: "", confidence: "baixa", evidence: [] },
									hda: { content: "", confidence: "baixa", evidence: [] },
									antecedentes: { content: "", confidence: "baixa", evidence: [] },
									alergias: { content: "", confidence: "baixa", evidence: [] },
									medicamentos_em_uso: { content: "", confidence: "baixa", evidence: [] },
									exame_fisico: { content: "", confidence: "baixa", evidence: [] },
									hipoteses: { content: "", confidence: "baixa", evidence: [] },
									conduta: { content: "", confidence: "baixa", evidence: [] },
								},
								engine: "stub",
							};
						}),
				}),
			),
		);
		await Effect.runPromise(runItems([{ id: 1, script: "hello world" }], ambient));
		expect(seenTranscript).toBe("hello world");
	});

	it("reports a failed outcome when the pipeline errors", async () => {
		const ports = Layer.mergeAll(
			Layer.succeed(
				TtsPort,
				TtsPort.of({
					synthesize: () => Effect.fail(new PortError({ port: "tts", message: "synth down" })),
				}),
			),
			Layer.succeed(
				AsrPort,
				AsrPort.of({
					transcribe: () => Effect.succeed({ asr: { text: "", segments: [] }, record }),
				}),
			),
		);
		const outcomes: { status: string; error?: string }[] = [];
		await Effect.runPromise(
			Effect.flatMap(EvalRunner, (r) =>
				r.run({
					runId: "r1",
					items: [{ id: 1, script: "x" }],
					onSample: (_id, outcome) =>
						Effect.sync(() => {
							outcomes.push({ status: outcome.status, error: outcome.error });
						}),
				}),
			).pipe(Effect.provide(makeEvalRunner(ports))),
		);
		expect(outcomes[0]?.status).toBe("failed");
		expect(outcomes[0]?.error).toContain("synth down");
	});
});

describe("evalArtifactsLocalDriver", () => {
	const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eval-artifacts-"));

	it("is eligible only when EVAL_RUNNER_DIR is set", () => {
		expect(evalArtifactsLocalDriver.when?.({}) ?? true).toBe(false);
		expect(evalArtifactsLocalDriver.when?.({ EVAL_RUNNER_DIR: artifactRoot }) ?? false).toBe(true);
	});

	it("reads bytes inside the root, null when missing, refuses outside", async () => {
		const filePath = path.join(artifactRoot, "a.wav");
		fs.writeFileSync(filePath, Buffer.from([9, 8, 7]));
		const layer = evalArtifactsLocalDriver.provides({
			EVAL_RUNNER_DIR: artifactRoot,
		}) as Layer.Layer<EvalArtifacts>;

		const bytes = await Effect.runPromise(
			Effect.flatMap(EvalArtifacts, (a) => a.getAudio(`file://${filePath}`)).pipe(
				Effect.provide(layer),
			),
		);
		expect(bytes ? [...bytes] : null).toEqual([9, 8, 7]);

		const missing = await Effect.runPromise(
			Effect.flatMap(EvalArtifacts, (a) => a.getAudio(`file://${artifactRoot}/gone.wav`)).pipe(
				Effect.provide(layer),
			),
		);
		expect(missing).toBeNull();

		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eval-artifacts-out-"));
		const outsideFile = path.join(outside, "b.wav");
		fs.writeFileSync(outsideFile, "x");
		const err = await Effect.runPromise(
			Effect.flatMap(EvalArtifacts, (a) => a.getAudio(`file://${outsideFile}`)).pipe(
				Effect.catchTag("PortError", (e) => Effect.succeed(e)),
				Effect.provide(layer),
			),
		);
		expect(String(err)).toContain("outside artifact root");
	});
});

describe("driver wiring", () => {
	it("evalRunnerLocalDriver.provides builds the runner layer", () => {
		const layer = evalRunnerLocalDriver.provides({
			EVAL_RUNNER_DIR: "/tmp/eval-run",
			EVAL_ASR_BASE_URL: "http://asr",
		});
		expect(layer).toBeDefined();
		// Custom timeout exercises the finite branch; unset/invalid
		// falls back to the 30min default.
		expect(
			evalRunnerLocalDriver.provides({
				EVAL_RUNNER_DIR: "/tmp/eval-run",
				EVAL_ASR_BASE_URL: "http://asr",
				EVAL_ASR_TIMEOUT_MS: "60000",
			}),
		).toBeDefined();
	});

	it("artifacts read fails as PortError when the target is unreadable", async () => {
		const artifactRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "eval-artifacts-dir-"));
		const dirTarget = path.join(artifactRoot2, "subdir");
		fs.mkdirSync(dirTarget);
		const layer = evalArtifactsLocalDriver.provides({
			EVAL_RUNNER_DIR: artifactRoot2,
		}) as Layer.Layer<EvalArtifacts>;
		const err = await Effect.runPromise(
			Effect.flatMap(EvalArtifacts, (a) => a.getAudio(`file://${dirTarget}`)).pipe(
				Effect.catchTag("PortError", (e) => Effect.succeed(e)),
				Effect.provide(layer),
			),
		);
		expect(err).toBeInstanceOf(PortError);
	});
});

it("artifacts also accepts bare paths without the file:// scheme", async () => {
	const artifactRoot3 = fs.mkdtempSync(path.join(os.tmpdir(), "eval-artifacts-bare-"));
	const filePath = path.join(artifactRoot3, "b.wav");
	fs.writeFileSync(filePath, Buffer.from([5]));
	const layer = evalArtifactsLocalDriver.provides({
		EVAL_RUNNER_DIR: artifactRoot3,
	}) as Layer.Layer<EvalArtifacts>;
	const bytes = await Effect.runPromise(
		Effect.flatMap(EvalArtifacts, (a) => a.getAudio(filePath)).pipe(Effect.provide(layer)),
	);
	expect(bytes ? [...bytes] : null).toEqual([5]);
});
