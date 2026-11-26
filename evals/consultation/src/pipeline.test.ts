import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { ptBR } from "./locales/pt-BR.ts";
import type { EditOp } from "@ktb/eval-core";
import { makePipelineRegistry, PipelineRunError } from "@ktb/pipeline";
import {
	processSample,
	EVAL_RUN_PIPELINE_ID,
	evalRunPack,
	transcribeSample,
	cleanupTranscript,
	cleanupTranscriptGated,
	entityQuestions,
	cleanupQuestions,
	CLEANUP_PROMPT,
	JUDGE_PROMPT,
	RUN_STAGE_PROMPTS,
	withStagePrompt,
	recordAll,
	saveSample,
	sampleForPersistence,
	toSampleResult,
	RUN_STAGE_FNS,
	runStageSelection,
	type RunStage,
} from "./pipeline.ts";
import {
	AsrPort,
	CleanupGate,
	DatasetStorePort,
	EvalPort,
	LlmPort,
	ReportPort,
	TtsPort,
	PortError,
} from "./ports.ts";
import type { RunRecord, Sample } from "./schema.ts";

const record: RunRecord = {
	runId: "r1",
	taskId: "t1",
	stage: "s",
	engine: "test",
	inputHash: "h",
	startedAt: 0,
};

const asrResult = {
	text: "o paciente nega febre e toma losartana 50 mg",
	language: "pt",
	segments: [
		{ t0: 0, t1: 1, text: "o paciente nega febre", confidence: 0.9 },
		{ t0: 1, t1: 2, text: "e toma losartana 50 mg" },
	],
};

const sample: Sample = {
	id: "s1",
	datasetVersion: "v1",
	origin: "synthetic",
	script: "o paciente nega febre e toma losartana 50 mg",
	scriptHash: "h",
	persona: {
		region: "southeast",
		ageBand: "adult",
		register: "colloquial",
		specialty: "general_practice",
	},
	audio: { uri: "stub://a" },
	gold: { validatedBy: "generator" },
};

const entities = [
	{ category: "negation" as const, value: "nega febre" },
	{ category: "medication" as const, value: "losartana 50 mg" },
];

const appended: RunRecord[] = [];
const stored = new Map<string, Sample>();
const storedResults = new Map<string, unknown>();

const live = Layer.mergeAll(
	Layer.succeed(
		AsrPort,
		// egress:false — the stub is local-only, so the PHI egress
		// policy lets untrusted-origin samples through to it.
		AsrPort.of({ egress: false, transcribe: () => Effect.succeed({ asr: asrResult, record }) }),
	),
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			egress: false,
			generate: () => Effect.succeed({ text: "script", record }),
			correct: (env) =>
				Effect.succeed({
					edits: {
						ops: [
							{
								at: 0,
								remove: env.input[0] ?? "",
								insert: (env.input[0] ?? "").toUpperCase(),
								kind: "punct",
							},
						],
					},
					record,
				}),
		}),
	),
	Layer.succeed(
		EvalPort,
		EvalPort.of({
			judge: (input) =>
				Effect.succeed({
					answers: input.questions.map((q) => ({
						id: q.id,
						kind: q.kind,
						value: q.kind === "noul" ? true : "justified_fix",
						probability: 0.97,
					})),
					record,
				}),
		}),
	),
	Layer.succeed(
		DatasetStorePort,
		DatasetStorePort.of({
			putSample: (s) => Effect.sync(() => void stored.set(s.id, s)),
			getSample: (id) => Effect.succeed(stored.get(id) ?? null),
			listSamples: () => Effect.succeed([sample]),
			putBlob: () => Effect.void,
			putBlobMeta: () => Effect.void,
			getBlob: () => Effect.succeed(null),
			getBlobMeta: () => Effect.succeed(null),
			putResult: (r) => Effect.sync(() => void storedResults.set(r.sampleId, r)),
			listResults: () => Effect.succeed([]),
		}),
	),
	Layer.succeed(
		ReportPort,
		ReportPort.of({
			append: (r) => Effect.sync(() => void appended.push(r)),
			render: () => Effect.succeed("report"),
		}),
	),
	Layer.succeed(
		TtsPort,
		TtsPort.of({
			synthesize: () => Effect.succeed({ audio: { uri: "stub://tts", size: 4 }, record }),
		}),
	),
);

/** Minimal store for tests that provide their own AsrPort —
 * transcribeSample resolves blob provenance through it. */
const storeStub = Layer.succeed(
	DatasetStorePort,
	DatasetStorePort.of({
		putSample: () => Effect.void,
		getSample: () => Effect.succeed(null),
		listSamples: () => Effect.succeed([]),
		putBlob: () => Effect.void,
		putBlobMeta: () => Effect.void,
		getBlob: () => Effect.succeed(null),
		getBlobMeta: () => Effect.succeed(null),
		putResult: () => Effect.void,
		listResults: () => Effect.succeed([]),
	}),
);

const run = <A>(e: Effect.Effect<A, unknown, unknown>) =>
	Effect.runPromise(Effect.provide(e as Effect.Effect<A, unknown, never>, live));

describe("cleanupTranscript", () => {
	it("delegates through the LlmPort and applies the edit list", async () => {
		const c = await run(cleanupTranscript({ taskId: "t", raw: "raw" }));
		expect(c.corrected.startsWith("R")).toBe(true);
		// T-135: the corrector prompt identity is stamped at the source
		// so every caller (processSample, EvalRunner) inherits it.
		expect(c.record.prompt).toEqual(CLEANUP_PROMPT);
	});

	const scriptedLlm = (
		calls: string[],
		opsFor: (env: { input: string }, attempt: number) => readonly EditOp[],
	) => {
		let attempt = 0;
		return Layer.succeed(
			LlmPort,
			LlmPort.of({
				generate: () => Effect.succeed({ text: "x", record }),
				correct: (env) => {
					calls.push(env.input);
					attempt += 1;
					return Effect.succeed({ edits: { ops: [...opsFor(env, attempt)] }, record });
				},
			}),
		);
	};

	it("timestamps mode: corrector sees [m:ss] segments, ops sanitize + anchor onto raw", async () => {
		const raw = "o paciente nega febre e toma losartana 50 mg";
		const calls: string[] = [];
		const r = await Effect.runPromise(
			cleanupTranscript({
				taskId: "t",
				raw,
				timestamps: [
					{ t0: 0, text: "o paciente nega febre" },
					{ t0: 61.9, text: "e toma losartana 50 mg" },
				],
			}).pipe(
				Effect.provide(
					scriptedLlm(calls, () => [
						// Quote spans a timestamp token — sanitized to the
						// plain span, then anchored onto raw.
						{
							at: 0,
							remove: "[1:01] e toma losartana",
							insert: "e toma enalapril",
							kind: "entity",
						},
						// Timestamp-only op — nothing survives sanitizing.
						{ at: 5, remove: "[0:00]", insert: "", kind: "format" },
						// Hallucinated timestamp inside insert — stripped.
						{ at: 0, remove: "o paciente", insert: "[0:02] O paciente", kind: "punct" },
					]),
				),
			),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("[0:00] o paciente nega febre");
		expect(calls[0]).toContain("[1:01] e toma losartana 50 mg");
		// Recorded ops span the PLAIN transcript — audit stays
		// consistent with asr.text; the timestamp-only op dropped.
		expect(r.edits.ops).toEqual([
			{ at: 0, remove: "o paciente", insert: "O paciente", kind: "punct" },
			{
				at: raw.indexOf("e toma losartana"),
				remove: "e toma losartana",
				insert: "e toma enalapril",
				kind: "entity",
			},
		]);
		expect(r.corrected).toBe("O paciente nega febre e toma enalapril 50 mg");
	});

	it("timestamps mode: a quote that only exists with markers drops instead of corrupting", async () => {
		const raw = "alpha beta gamma";
		const calls: string[] = [];
		const r = await Effect.runPromise(
			cleanupTranscript({
				taskId: "t",
				raw,
				timestamps: [{ t0: 0, text: "alpha beta gamma" }],
			}).pipe(
				Effect.provide(
					scriptedLlm(calls, () => [
						// "[0:00] alpha\n[0:05] beta" spans the newline join —
						// after sanitizing it is "alpha beta", which DOES
						// anchor; a marker-joined quote that sanitizes to
						// nothing meaningful drops below.
						{ at: 0, remove: "[0:00] alpha [0:05] beta", insert: "alpha BETA", kind: "fix" },
						{ at: 0, remove: "[9:99] nonexistent", insert: "x", kind: "fix" },
					]),
				),
			),
		);
		expect(r.edits.ops).toEqual([
			{ at: 0, remove: "alpha beta", insert: "alpha BETA", kind: "fix" },
		]);
		expect(r.corrected).toBe("alpha BETA gamma");
	});

	it("retries once when the edit list does not apply, then succeeds", async () => {
		const calls: string[] = [];
		const records: RunRecord[] = [];
		const r = await Effect.runPromise(
			cleanupTranscript({
				taskId: "t",
				raw: "raw text here",
				onRecord: (x) => records.push(x),
			}).pipe(
				Effect.provide(
					scriptedLlm(calls, (_env, attempt) =>
						attempt === 1
							? // Quotes text absent from the transcript — applyEdits throws.
								[{ at: 0, remove: "NOT-IN-TEXT", insert: "x", kind: "fix" }]
							: [{ at: 0, remove: "raw", insert: "RAW", kind: "fix" }],
					),
				),
			),
		);
		expect(calls).toHaveLength(2);
		// Both attempts left their audit record.
		expect(records).toHaveLength(2);
		expect(r.corrected).toBe("RAW text here");
	});

	it("fails typed when the retry also produces a corrupt edit list", async () => {
		const calls: string[] = [];
		const err = await Effect.runPromise(
			cleanupTranscript({ taskId: "t", raw: "raw text" }).pipe(
				Effect.provide(
					scriptedLlm(calls, () => [{ at: 0, remove: "ABSENT", insert: "x", kind: "fix" }]),
				),
				Effect.flip,
			),
		);
		expect(calls).toHaveLength(2);
		expect(err).toBeInstanceOf(PortError);
		expect((err as PortError).port).toBe("pipeline");
		expect((err as PortError).message).toContain("corrupt edit list");
	});

	it("does not retry LlmPort failures — batch-level retry owns those", async () => {
		let calls = 0;
		const llm = Layer.succeed(
			LlmPort,
			LlmPort.of({
				generate: () => Effect.succeed({ text: "x", record }),
				correct: () => {
					calls += 1;
					return Effect.fail(new PortError({ port: "llm", message: "transport down" }));
				},
			}),
		);
		const err = await Effect.runPromise(
			cleanupTranscript({ taskId: "t", raw: "raw" }).pipe(Effect.provide(llm), Effect.flip),
		);
		expect(calls).toBe(1);
		expect((err as PortError).port).toBe("llm");
	});
});

describe("cleanupTranscriptGated", () => {
	const gatedLlm = (calls: string[], ops: (env: { input: string }) => readonly EditOp[]) =>
		Layer.succeed(
			LlmPort,
			LlmPort.of({
				generate: () => Effect.succeed({ text: "x", record }),
				correct: (env) => {
					calls.push(env.input);
					return Effect.succeed({ edits: { ops: [...ops(env)] }, record });
				},
			}),
		);

	it("sends only the flagged span and shifts ops to full-text offsets", async () => {
		const raw = "o paciente nega febre e toma losartana 50 mg";
		const start = raw.indexOf("e toma");
		const calls: string[] = [];
		const records: RunRecord[] = [];
		const r = await Effect.runPromise(
			cleanupTranscriptGated({
				taskId: "t",
				raw,
				ranges: [{ start, end: raw.length }],
				onRecord: (x) => records.push(x),
			}).pipe(
				Effect.provide(
					gatedLlm(calls, () => [
						{ at: 999, remove: "losartana", insert: "enalapril", kind: "entity" },
					]),
				),
			),
		);
		expect(calls).toEqual(["e toma losartana 50 mg"]);
		// at:999 is a hallucinated offset — anchorEdits re-anchors
		// "losartana" inside the slice, then the shift lands it on the
		// transcript's real position.
		expect(r.edits.ops).toEqual([
			{ at: raw.indexOf("losartana"), remove: "losartana", insert: "enalapril", kind: "entity" },
		]);
		expect(r.corrected).toBe("o paciente nega febre e toma enalapril 50 mg");
		expect(records).toHaveLength(1);
		expect(records[0]!.prompt).toEqual(CLEANUP_PROMPT);
	});

	it("drops ops it cannot verify inside the span", async () => {
		const raw = "alpha beta gamma";
		const calls: string[] = [];
		const r = await Effect.runPromise(
			cleanupTranscriptGated({ taskId: "t", raw, ranges: [{ start: 0, end: 10 }] }).pipe(
				Effect.provide(
					gatedLlm(calls, () => [
						// "gamma" is outside the sent span — the model never saw
						// it, so this op is unverifiable and must be dropped.
						{ at: 0, remove: "gamma", insert: "delta", kind: "fix" },
						{ at: 6, remove: "beta", insert: "BETA", kind: "fix" },
					]),
				),
			),
		);
		expect(calls).toEqual(["alpha beta"]);
		expect(r.edits.ops).toEqual([{ at: 6, remove: "beta", insert: "BETA", kind: "fix" }]);
		expect(r.corrected).toBe("alpha BETA gamma");
	});

	it("runs no corrector call for an empty gate decision", async () => {
		const calls: string[] = [];
		const r = await Effect.runPromise(
			cleanupTranscriptGated({ taskId: "t", raw: "intact", ranges: [] }).pipe(
				Effect.provide(gatedLlm(calls, () => [])),
			),
		);
		expect(calls).toEqual([]);
		expect(r.edits.ops).toEqual([]);
		expect(r.corrected).toBe("intact");
	});
});

describe("transcribeSample", () => {
	it("returns ASR output", async () => {
		const r = await run(transcribeSample(sample));
		expect(r.asr.text).toContain("losartana");
	});

	it("fails when the sample has no audio", async () => {
		const err = await run(
			transcribeSample({ ...sample, audio: undefined }).pipe(
				Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
			),
		);
		expect(err).toBeInstanceOf(PortError);
	});

	it("forwards the sample origin and stored blob provenance to the ASR port", async () => {
		let seen: unknown;
		const capture = Layer.succeed(
			AsrPort,
			AsrPort.of({
				transcribe: (_audio, opts) =>
					Effect.sync(() => {
						seen = opts;
						return { asr: asrResult, record };
					}),
			}),
		);
		await Effect.runPromise(
			Effect.provide(transcribeSample(sample), Layer.merge(capture, storeStub)),
		);
		expect(seen).toEqual({ language: "pt", origin: "synthetic", blobMeta: null });
	});

	it("passes the blob's stored provenance through to the ASR port", async () => {
		let seen: unknown;
		const capture = Layer.succeed(
			AsrPort,
			// egress:false — local-only, so the PHI guard lets the
			// real_anonymized blobMeta through to observe the opts.
			AsrPort.of({
				egress: false,
				transcribe: (_audio, opts) =>
					Effect.sync(() => {
						seen = opts;
						return { asr: asrResult, record };
					}),
			}),
		);
		const metaStore = Layer.succeed(
			DatasetStorePort,
			DatasetStorePort.of({
				putSample: () => Effect.void,
				getSample: () => Effect.succeed(null),
				listSamples: () => Effect.succeed([]),
				putBlob: () => Effect.void,
				putBlobMeta: () => Effect.void,
				getBlob: () => Effect.succeed(null),
				getBlobMeta: () => Effect.succeed({ origin: "real_anonymized" as const }),
				putResult: () => Effect.void,
				listResults: () => Effect.succeed([]),
			}),
		);
		await Effect.runPromise(
			Effect.provide(transcribeSample(sample), Layer.merge(capture, metaStore)),
		);
		expect(seen).toEqual({
			language: "pt",
			origin: "synthetic",
			blobMeta: { origin: "real_anonymized" },
		});
	});

	it("fails closed when the blob provenance lookup fails", async () => {
		const err = await Effect.runPromise(
			Effect.provide(
				transcribeSample(sample).pipe(
					Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
				),
				Layer.mergeAll(
					Layer.succeed(
						AsrPort,
						AsrPort.of({ transcribe: () => Effect.succeed({ asr: asrResult, record }) }),
					),
					Layer.succeed(
						DatasetStorePort,
						DatasetStorePort.of({
							putSample: () => Effect.void,
							getSample: () => Effect.succeed(null),
							listSamples: () => Effect.succeed([]),
							putBlob: () => Effect.void,
							putBlobMeta: () => Effect.void,
							getBlob: () => Effect.succeed(null),
							getBlobMeta: () =>
								Effect.fail(new PortError({ port: "store", message: "store down" })),
							putResult: () => Effect.void,
							listResults: () => Effect.succeed([]),
						}),
					),
				),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("store down");
	});

	it("forwards the locale profile's ASR language", async () => {
		let seen: unknown;
		const capture = Layer.succeed(
			AsrPort,
			AsrPort.of({
				transcribe: (_audio, opts) =>
					Effect.sync(() => {
						seen = opts;
						return { asr: asrResult, record };
					}),
			}),
		);
		const xx = { ...ptBR, id: "xx-v1", asrLanguage: "xx" };
		await Effect.runPromise(
			Effect.provide(transcribeSample(sample, xx), Layer.merge(capture, storeStub)),
		);
		expect(seen).toEqual({ language: "xx", origin: "synthetic", blobMeta: null });
	});
});

describe("question builders", () => {
	it("entity questions are per-stage noul", () => {
		const qs = entityQuestions(entities, "corrected");
		expect(qs).toHaveLength(2);
		expect(qs[0]?.id).toBe("entity:corrected:negation:0");
		expect(qs[0]?.kind).toBe("noul");
	});

	it("cleanup questions are choice per edit", () => {
		const qs = cleanupQuestions({
			ops: [{ at: 0, remove: "a", insert: "b", kind: "fix" }],
		});
		expect(qs[0]?.kind).toBe("choice");
		expect(qs[0]?.options).toContain("harmful");
	});
});

describe("processSample — gated cleanup", () => {
	/** Gate that flags only the second ASR segment ("e toma losartana
	 * 50 mg") — the corrector then sees just that span. */
	const gateLayer = (
		ranges: readonly { start: number; end: number }[],
		name = "test-gate",
		selectCalls: { sampleId: string; segmentCount: number }[] = [],
		gateRecords: readonly RunRecord[] = [],
	) =>
		Layer.succeed(
			CleanupGate,
			CleanupGate.of({
				name,
				select: (input) => {
					selectCalls.push({ sampleId: input.sampleId, segmentCount: input.segments.length });
					return Effect.succeed({
						ranges,
						segmentsScored: input.segments.length,
						records: gateRecords,
					});
				},
			}),
		);

	it("gates the corrector input and records CleanupGateStats", async () => {
		const selectCalls: { sampleId: string; segmentCount: number }[] = [];
		const records: RunRecord[] = [];
		// A live detector returns its own judge records — they land on
		// the run's audit trail tagged like every other stage record.
		const detectorRecord: RunRecord = {
			runId: "eval",
			taskId: "judge:q",
			stage: "judge",
			engine: "systemone",
			inputHash: "qh",
			startedAt: 1,
		};
		const r = await Effect.runPromise(
			Effect.provide(
				processSample({ sample, entities, recordsOut: records }),
				Layer.merge(
					live,
					gateLayer([{ start: 1, end: 1 }], "test-gate", selectCalls, [detectorRecord]),
				),
			),
		);
		expect(selectCalls).toEqual([{ sampleId: "s1", segmentCount: 2 }]);
		// The stub corrector uppercases slice[0] — the gated slice is
		// "e toma losartana 50 mg", so the edit lands on "e" at the
		// span's start in the full transcript.
		expect(r.corrected).toBe("o paciente nega febre E toma losartana 50 mg");
		expect(r.cleanupGate).toEqual({
			gate: "test-gate",
			segmentsScored: 2,
			ranges: 1,
			wordsSent: 5,
			wordsTotal: 9,
		});
		// The decision record is on the audit trail — engine names the
		// gate, inputHash pins the transcript it decided over — as is
		// the detector's own judge record.
		const gateRec = records.find((x) => x.stage === "cleanup-gate");
		expect(gateRec?.engine).toBe("test-gate");
		expect(records.find((x) => x.taskId === "judge:q")?.engine).toBe("systemone");
		// The persisted result carries the same gate audit.
		const result = toSampleResult({ sample, runId: "r", run: r });
		expect(result.cleanupGate).toEqual(r.cleanupGate);
	});

	it("an all-clear gate decision leaves the transcript untouched", async () => {
		const r = await Effect.runPromise(
			Effect.provide(processSample({ sample, entities }), Layer.merge(live, gateLayer([]))),
		);
		expect(r.corrected).toBe(r.asr.text);
		expect(r.edits?.ops).toEqual([]);
		expect(r.cleanupGate).toMatchObject({ gate: "test-gate", ranges: 0, wordsSent: 0 });
	});

	it("propagates gate failures as PortErrors", async () => {
		const failing = Layer.succeed(
			CleanupGate,
			CleanupGate.of({
				name: "down",
				select: () => Effect.fail(new PortError({ port: "cleanup-gate", message: "down" })),
			}),
		);
		const exit = await Effect.runPromiseExit(
			Effect.provide(processSample({ sample, entities }), Layer.merge(live, failing)),
		);
		expect(exit._tag).toBe("Failure");
	});
});

describe("processSample", () => {
	it("runs S3→S4→S7 and reports per-stage metrics", async () => {
		const r = await run(processSample({ sample, entities }));
		expect(r.corrected!.startsWith("O")).toBe(true);
		expect(r.asrMetrics.wer).toBe(0);
		expect(r.asrMetrics.criticalErrors).toBe(0);
		expect(r.editVerdicts[0]?.classification).toBe("justified_fix");
		expect(r.confSegments).toHaveLength(2);
	});

	it("persists the locale profile id as the normalization label", async () => {
		const xx = { ...ptBR, id: "xx-v1", asrLanguage: "xx" };
		const r = await run(processSample({ sample, entities, profile: xx }));
		expect(r.asrMetrics.normalization).toBe("xx-v1");
		expect(r.correctedMetrics!.normalization).toBe("xx-v1");
	});

	it("skips judging when there is nothing to ask", async () => {
		const r = await run(processSample({ sample, entities: [] }));
		expect(r.asrMetrics.entityVerdicts).toHaveLength(0);
	});

	it("sample without audio fails at transcribe (no provenance lookup)", async () => {
		const err = await run(
			processSample({ sample: { ...sample, audio: undefined }, entities }).pipe(
				Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("no audio");
	});

	it("real_anonymized: fails closed when the PHI gate finds residuals", async () => {
		const real: Sample = {
			...sample,
			origin: "real_anonymized",
			// 14-digit run survives every scrub pattern → gate returns null.
			script: "registro interno 20240102030405 do paciente",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		const err = await run(
			processSample({ sample: real, entities }).pipe(
				Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("PHI gate");
	});

	it("real_anonymized: scrubs the script before it reaches judge state", async () => {
		const seen: unknown[] = [];
		const captureJudge = Layer.succeed(
			EvalPort,
			EvalPort.of({
				judge: (input) =>
					Effect.sync(() => {
						seen.push(input.state);
						return {
							answers: input.questions.map((q) => ({
								id: q.id,
								kind: q.kind,
								value: q.kind === "noul" ? true : "justified_fix",
								probability: 0.9,
							})),
							record,
						};
					}),
			}),
		);
		const real: Sample = {
			...sample,
			origin: "real_anonymized",
			script: "paciente cpf 123.456.789-00 nega febre",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		await Effect.runPromise(
			Effect.provide(processSample({ sample: real, entities }), Layer.merge(live, captureJudge)),
		);
		const dumped = JSON.stringify(seen);
		expect(dumped).toContain("[CPF]");
		expect(dumped).not.toContain("123.456.789-00");
	});

	it("real_anonymized: scrubs ASR text before cleanup and judge state (H1)", async () => {
		const phiAsr = {
			text: "paciente cpf 123.456.789-00 nega febre",
			language: "pt",
			segments: [{ t0: 0, t1: 1, text: "cpf 123.456.789-00" }],
		};
		const llmInputs: string[] = [];
		const judgeStates: unknown[] = [];
		const phiPorts = Layer.mergeAll(
			Layer.succeed(
				AsrPort,
				AsrPort.of({ egress: false, transcribe: () => Effect.succeed({ asr: phiAsr, record }) }),
			),
			Layer.succeed(
				LlmPort,
				LlmPort.of({
					egress: false,
					generate: () => Effect.succeed({ text: "x", record }),
					correct: (env) =>
						Effect.sync(() => {
							llmInputs.push(env.input);
							return { edits: { ops: [] }, record };
						}),
				}),
			),
			Layer.succeed(
				EvalPort,
				EvalPort.of({
					egress: false,
					judge: (input) =>
						Effect.sync(() => {
							judgeStates.push(input.state);
							return {
								answers: input.questions.map((q) => ({
									id: q.id,
									kind: q.kind,
									value: q.kind === "noul" ? true : "justified_fix",
									probability: 0.9,
								})),
								record,
							};
						}),
				}),
			),
		);
		const real: Sample = {
			...sample,
			origin: "real_anonymized",
			script: "paciente nega febre",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		const r = await Effect.runPromise(
			Effect.provide(processSample({ sample: real, entities }), Layer.merge(live, phiPorts)),
		);
		// cleanup input, judge states and persisted text are all scrubbed
		expect(llmInputs).toHaveLength(1);
		expect(llmInputs[0]).toContain("[CPF]");
		expect(llmInputs[0]).not.toContain("123.456.789-00");
		const dumped = JSON.stringify(judgeStates);
		expect(dumped).toContain("[CPF]");
		expect(dumped).not.toContain("123.456.789-00");
		expect(r.asr.text).toContain("[CPF]");
		expect(r.asr.text).not.toContain("123.456.789-00");
		expect(r.script).toBe("paciente nega febre");
	});

	it("unknown origin: script and ASR text are gated like real_anonymized", async () => {
		const phiAsr = {
			text: "meu cpf 123.456.789-00",
			language: "pt",
			segments: [],
		};
		const judgeStates: unknown[] = [];
		const phiPorts = Layer.mergeAll(
			Layer.succeed(
				AsrPort,
				AsrPort.of({ egress: false, transcribe: () => Effect.succeed({ asr: phiAsr, record }) }),
			),
			Layer.succeed(
				EvalPort,
				EvalPort.of({
					egress: false,
					judge: (input) =>
						Effect.sync(() => {
							judgeStates.push(input.state);
							return {
								answers: input.questions.map((q) => ({
									id: q.id,
									kind: q.kind,
									value: q.kind === "noul" ? true : "justified_fix",
									probability: 0.9,
								})),
								record,
							};
						}),
				}),
			),
		);
		const unknown: Sample = {
			...sample,
			origin: "unknown",
			script: "cpf 123.456.789-00 do paciente",
		};
		const r = await Effect.runPromise(
			Effect.provide(processSample({ sample: unknown, entities }), Layer.merge(live, phiPorts)),
		);
		expect(r.script).toContain("[CPF]");
		expect(r.script).not.toContain("123.456.789-00");
		expect(r.asr.text).toContain("[CPF]");
		expect(JSON.stringify(judgeStates)).not.toContain("123.456.789-00");
	});

	it("synthetic-declared + real_anonymized blobMeta: text is scrubbed like untrusted", async () => {
		// The declared origin says "synthetic" but the blob's STORED
		// provenance says real_anonymized — the effective origin is
		// untrusted, so the script gate AND the ASR-text scrub must
		// both fire (previously only the audio egress guard saw the
		// stored channel and real PHI flowed to LlmPort/judge/persist).
		const phiAsr = {
			text: "paciente cpf 123.456.789-00 nega febre",
			language: "pt",
			segments: [],
		};
		const judgeStates: unknown[] = [];
		const phiPorts = Layer.mergeAll(
			Layer.succeed(
				AsrPort,
				AsrPort.of({ egress: false, transcribe: () => Effect.succeed({ asr: phiAsr, record }) }),
			),
			Layer.succeed(
				EvalPort,
				EvalPort.of({
					judge: (input) =>
						Effect.sync(() => {
							judgeStates.push(input.state);
							return {
								answers: input.questions.map((q) => ({
									id: q.id,
									kind: q.kind,
									value: q.kind === "noul" ? true : "justified_fix",
									probability: 0.9,
								})),
								record,
							};
						}),
				}),
			),
		);
		const metaStore = Layer.succeed(
			DatasetStorePort,
			DatasetStorePort.of({
				putSample: () => Effect.void,
				getSample: () => Effect.succeed(null),
				listSamples: () => Effect.succeed([]),
				putBlob: () => Effect.void,
				putBlobMeta: () => Effect.void,
				getBlob: () => Effect.succeed(null),
				getBlobMeta: () => Effect.succeed({ origin: "real_anonymized" as const }),
				putResult: () => Effect.void,
				listResults: () => Effect.succeed([]),
			}),
		);
		const lying: Sample = {
			...sample,
			origin: "synthetic",
			script: "cpf 123.456.789-00 do paciente",
		};
		const r = await Effect.runPromise(
			Effect.provide(
				processSample({ sample: lying, entities }),
				Layer.mergeAll(live, phiPorts, metaStore),
			),
		);
		// Script gated before judging/persistence; ASR text scrubbed
		// before cleanup — the declared "synthetic" did not exempt it.
		expect(r.script).toContain("[CPF]");
		expect(r.script).not.toContain("123.456.789-00");
		expect(r.asr.text).toContain("[CPF]");
		expect(r.asr.text).not.toContain("123.456.789-00");
		const dumped = JSON.stringify(judgeStates);
		expect(dumped).toContain("[CPF]");
		expect(dumped).not.toContain("123.456.789-00");
	});

	it("synthetic-declared + synthetic blobMeta: no scrub (both channels agree)", async () => {
		const metaStore = Layer.succeed(
			DatasetStorePort,
			DatasetStorePort.of({
				putSample: () => Effect.void,
				getSample: () => Effect.succeed(null),
				listSamples: () => Effect.succeed([]),
				putBlob: () => Effect.void,
				putBlobMeta: () => Effect.void,
				getBlob: () => Effect.succeed(null),
				getBlobMeta: () => Effect.succeed({ origin: "synthetic" as const }),
				putResult: () => Effect.void,
				listResults: () => Effect.succeed([]),
			}),
		);
		const r = await Effect.runPromise(
			Effect.provide(processSample({ sample, entities }), Layer.merge(live, metaStore)),
		);
		expect(r.script).toBe(sample.script);
		expect(r.asr.text).toBe(asrResult.text);
	});

	it("real_anonymized: fails closed when ASR output has residual identifiers", async () => {
		const badAsr = {
			text: "registro interno 20240102030405",
			language: "pt",
			segments: [],
		};
		const badPorts = Layer.mergeAll(
			Layer.succeed(
				AsrPort,
				AsrPort.of({ egress: false, transcribe: () => Effect.succeed({ asr: badAsr, record }) }),
			),
			Layer.succeed(
				LlmPort,
				LlmPort.of({
					egress: false,
					generate: () => Effect.succeed({ text: "x", record }),
					correct: () => Effect.succeed({ edits: { ops: [] }, record }),
				}),
			),
		);
		const real: Sample = {
			...sample,
			origin: "real_anonymized",
			script: "paciente nega febre",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		const err = await Effect.runPromise(
			Effect.provide(
				processSample({ sample: real, entities }).pipe(
					Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
				),
				Layer.merge(live, badPorts),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("ASR output");
	});

	it("egress-capable ASR refuses real_anonymized before transcribing (M2)", async () => {
		let called = 0;
		const cloudAsr = Layer.succeed(
			AsrPort,
			AsrPort.of({
				egress: true,
				transcribe: () =>
					Effect.sync(() => {
						called++;
						return { asr: asrResult, record };
					}),
			}),
		);
		const real: Sample = {
			...sample,
			origin: "real_anonymized",
			script: "paciente nega febre",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		const err = await Effect.runPromise(
			Effect.provide(
				processSample({ sample: real, entities }).pipe(
					Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
				),
				Layer.merge(live, cloudAsr),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("egress");
		expect(called).toBe(0);
	});

	it("egress-capable ASR refuses when stored blob provenance is real_anonymized", async () => {
		let called = 0;
		const cloudAsr = Layer.succeed(
			AsrPort,
			AsrPort.of({
				egress: true,
				transcribe: () =>
					Effect.sync(() => {
						called++;
						return { asr: asrResult, record };
					}),
			}),
		);
		const metaStore = Layer.succeed(
			DatasetStorePort,
			DatasetStorePort.of({
				putSample: () => Effect.void,
				getSample: () => Effect.succeed(null),
				listSamples: () => Effect.succeed([]),
				putBlob: () => Effect.void,
				putBlobMeta: () => Effect.void,
				getBlob: () => Effect.succeed(null),
				getBlobMeta: () => Effect.succeed({ origin: "real_anonymized" as const }),
				putResult: () => Effect.void,
				listResults: () => Effect.succeed([]),
			}),
		);
		const err = await Effect.runPromise(
			Effect.provide(
				transcribeSample(sample).pipe(
					Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
				),
				Layer.mergeAll(cloudAsr, metaStore),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(called).toBe(0);
	});
});

describe("prompt identities (T-135)", () => {
	it("declares stable name/version/fnv1a-hash bindings per LLM stage", () => {
		for (const p of [CLEANUP_PROMPT, JUDGE_PROMPT]) {
			expect(p.name).toMatch(/^eval\.consultation\//);
			expect(p.version).toBe(1);
			expect(p.hash).toMatch(/^[0-9a-f]{8}$/);
		}
		expect(CLEANUP_PROMPT.name).toBe("eval.consultation/cleanup-corrector");
		expect(JUDGE_PROMPT.name).toBe("eval.consultation/judge-questions");
		// The stage map covers exactly the LLM-consuming run stages —
		// transcribe takes audio, not a prompt.
		expect(RUN_STAGE_PROMPTS).toEqual({ cleanup: CLEANUP_PROMPT, judge: JUDGE_PROMPT });
	});

	it("withStagePrompt fills absent refs and never overwrites adapter-stamped ones", () => {
		expect(withStagePrompt(CLEANUP_PROMPT)(record).prompt).toEqual(CLEANUP_PROMPT);
		const stamped = { ...record, prompt: { name: "adapter/judge", version: 2 } };
		expect(withStagePrompt(JUDGE_PROMPT)(stamped).prompt).toEqual({
			name: "adapter/judge",
			version: 2,
		});
	});

	it("stamps prompt refs on cleanup and judge records — transcribe stays clean", async () => {
		const r = await run(processSample({ sample, entities }));
		// Default pipeline: 1 transcribe + 1 cleanup + 3 judge records,
		// in dispatch order (the fixture ports all report stage "s").
		expect(r.records).toHaveLength(5);
		expect(r.records[0]!.prompt).toBeUndefined();
		expect(r.records[1]!.prompt).toEqual(CLEANUP_PROMPT);
		for (const j of r.records.slice(2)) {
			expect(j.prompt).toEqual(JUDGE_PROMPT);
		}
	});
});

describe("recordAll / saveSample", () => {
	it("append and persist", async () => {
		await run(recordAll([record]));
		await run(saveSample(sample));
		expect(appended).toContain(record);
		expect(stored.get(sample.id)).toEqual(sample);
	});
});

describe("failure modes", () => {
	it("corrupt edit list → typed PortError, not a defect", async () => {
		const badLlm = Layer.succeed(
			LlmPort,
			LlmPort.of({
				generate: () => Effect.succeed({ text: "x", record }),
				correct: () =>
					Effect.succeed({
						edits: { ops: [{ at: 5, remove: "nope", insert: "x", kind: "fix" }] },
						record,
					}),
			}),
		);
		const err = await Effect.runPromise(
			Effect.provide(
				cleanupTranscript({ taskId: "t", raw: "texto real" }).pipe(
					Effect.catchTag("PortError", (e) => Effect.succeed(e)),
				),
				badLlm,
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("corrupt edit list");
	});

	it("recordsOut exposes partial stage records when judging fails mid-pipeline", async () => {
		// Judge succeeds for the ASR-stage questions, fails on the
		// corrected-stage call — the sample dies mid-pipeline but its
		// ASR/cleanup/judge-asr records must already be collected.
		const failOnCorrected = Layer.succeed(
			EvalPort,
			EvalPort.of({
				judge: (input) =>
					input.questions.some((q) => q.id.startsWith("entity:corrected"))
						? Effect.fail(new PortError({ port: "eval", message: "judge down" }))
						: Effect.succeed({
								answers: input.questions.map((q) => ({
									id: q.id,
									kind: q.kind,
									value: q.kind === "noul" ? true : "justified_fix",
									probability: 0.9,
								})),
								record,
							}),
			}),
		);
		const collected: RunRecord[] = [];
		const err = await Effect.runPromise(
			Effect.provide(
				processSample({ sample, entities, recordsOut: collected }).pipe(
					Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
				),
				Layer.merge(live, failOnCorrected),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		// transcribe + cleanup + the successful ASR judge call — the
		// corrected-stage judge record never existed.
		expect(collected).toHaveLength(3);
		expect(collected.every((r) => r.sampleId === "s1" && r.datasetVersion === "v1")).toBe(true);
	});

	it("recordsOut keeps the LLM records when edit application fails", async () => {
		// correct() succeeds (record produced) but the edit list is
		// corrupt — the corrupt-list retry (T-207) fires a second
		// correct() call, so the sample fails mid-cleanup yet the ASR
		// record and BOTH corrector attempts are already collected.
		const badLlm = Layer.succeed(
			LlmPort,
			LlmPort.of({
				generate: () => Effect.succeed({ text: "x", record }),
				correct: () =>
					Effect.succeed({
						edits: { ops: [{ at: 5, remove: "nope", insert: "x", kind: "fix" }] },
						record,
					}),
			}),
		);
		const collected: RunRecord[] = [];
		const err = await Effect.runPromise(
			Effect.provide(
				processSample({ sample, entities, recordsOut: collected }).pipe(
					Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
				),
				Layer.merge(live, badLlm),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("corrupt edit list");
		expect(collected).toHaveLength(3);
	});

	it("missing judge answer → unjudged, never silently benign", async () => {
		const emptyJudge = Layer.succeed(
			EvalPort,
			EvalPort.of({
				judge: () => Effect.succeed({ answers: [], record }),
			}),
		);
		const r = await Effect.runPromise(
			Effect.provide(processSample({ sample, entities }), Layer.merge(live, emptyJudge)),
		);
		expect(r.editVerdicts[0]?.classification).toBe("unjudged");
	});
});

describe("toSampleResult / saveResult / recordAll", () => {
	it("persists the full audit trail", async () => {
		const { toSampleResult, saveResult, recordAll } = await import("./pipeline.ts");
		const r = await run(processSample({ sample, entities, runId: "run-x" }));
		const result = toSampleResult({ sample, runId: "run-x", run: r });
		expect(result.sampleId).toBe("s1");
		expect(result.asrText).toContain("losartana");
		expect(result.edits?.ops).toHaveLength(1);

		await run(saveResult(result));
		expect(storedResults.get("s1")).toEqual(result);

		appended.length = 0;
		await run(recordAll(r.records));
		expect(appended.length).toBeGreaterThan(0);
		expect(appended.every((x) => x.runId === "run-x" && x.sampleId === "s1")).toBe(true);
	});

	it("entities default to gold.entities when not passed", async () => {
		const s2: Sample = { ...sample, gold: { validatedBy: "generator", entities } };
		const r = await run(processSample({ sample: s2 }));
		expect(r.asrMetrics.entityVerdicts).toHaveLength(2);
	});
});

describe("sampleForPersistence (H2)", () => {
	it("returns the synthetic sample unchanged", async () => {
		const r = await run(processSample({ sample, entities }));
		expect(sampleForPersistence(sample, r)).toBe(sample);
	});

	it("persists the scrubbed script + recomputed hash for real_anonymized", async () => {
		const real: Sample = {
			...sample,
			origin: "real_anonymized",
			script: "cpf 123.456.789-00 do paciente",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		const r = await run(processSample({ sample: real, entities }));
		const persisted = sampleForPersistence(real, r);
		expect(persisted.script).toContain("[CPF]");
		expect(persisted.script).not.toContain("123.456.789-00");
		expect(persisted.scriptHash).not.toBe(real.scriptHash);
		// The stored row must still decode — scrubbed script is valid.
		expect(persisted.scriptHash).toMatch(/^[0-9a-f]{8}$/);
	});

	it("toSampleResult persists only scrubbed text fields", async () => {
		const phiAsr = {
			text: "cpf 123.456.789-00 nega febre",
			language: "pt",
			segments: [],
		};
		const phiPorts = Layer.succeed(
			AsrPort,
			AsrPort.of({ egress: false, transcribe: () => Effect.succeed({ asr: phiAsr, record }) }),
		);
		const real: Sample = {
			...sample,
			origin: "real_anonymized",
			script: "paciente nega febre",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		const r = await Effect.runPromise(
			Effect.provide(processSample({ sample: real, entities }), Layer.merge(live, phiPorts)),
		);
		const result = toSampleResult({ sample: real, runId: "run-phi", run: r });
		expect(result.asrText).toContain("[CPF]");
		expect(result.asrText).not.toContain("123.456.789-00");
		const dumped = JSON.stringify(result.edits ?? []);
		expect(dumped).not.toContain("123.456.789-00");
	});
});

describe("defaults", () => {
	it("processSample with no entities arg and no gold.entities judges nothing", async () => {
		const r = await run(processSample({ sample }));
		expect(r.asrMetrics.entityVerdicts).toHaveLength(0);
	});
});

describe("run-stage selection", () => {
	it("runStageSelection keeps run ids in declared order, drops the rest", () => {
		expect(runStageSelection(["script_gen", "synthesize", "transcribe", "cleanup"])).toEqual([
			"transcribe",
			"cleanup",
		]);
		expect(runStageSelection(["transcribe", "cleanup", "judge"])).toEqual([
			"transcribe",
			"cleanup",
			"judge",
		]);
	});

	it("rejects empty, duplicate, out-of-order and transcribe-less selections", () => {
		expect(() => runStageSelection(["script_gen"])).toThrow(/no run stages selected/);
		expect(() => runStageSelection(["transcribe", "transcribe"])).toThrow(/listed twice/);
		expect(() => runStageSelection(["cleanup", "transcribe"])).toThrow(/out of order/);
		expect(() => runStageSelection(["judge", "cleanup", "transcribe"])).toThrow(/out of order/);
		expect(() => runStageSelection(["cleanup"])).toThrow(/require "transcribe"/);
		expect(() => runStageSelection(["judge"])).toThrow(/require "transcribe"/);
	});

	it("stages [transcribe, cleanup] skips the judge — floor verdicts, unjudged edits", async () => {
		const r = await run(processSample({ sample, entities, stages: ["transcribe", "cleanup"] }));
		expect(r.corrected).toBeDefined();
		expect(r.correctedMetrics).toBeDefined();
		// No judge ran → every verdict is the text floor, every edit
		// verdict is "unjudged" (the live judge would have answered).
		expect(r.correctedMetrics!.entityVerdicts.every((v) => v.source === "text_floor")).toBe(true);
		expect(r.editVerdicts.length).toBeGreaterThan(0);
		expect(r.editVerdicts.every((v) => v.classification === "unjudged")).toBe(true);
	});

	it("stages [transcribe] produces asr-only results", async () => {
		const r = await run(processSample({ sample, entities, stages: ["transcribe"] }));
		expect(r.asrMetrics.wer).toBe(0);
		expect(r.edits).toBeUndefined();
		expect(r.corrected).toBeUndefined();
		expect(r.correctedMetrics).toBeUndefined();
		expect(r.editVerdicts).toEqual([]);
		const result = toSampleResult({ sample, runId: "r-asr", run: r });
		expect(result.asrText).toBe(r.asr.text);
		expect(result.correctedText).toBeUndefined();
		expect(result.edits).toBeUndefined();
		expect(result.correctedMetrics).toBeUndefined();
	});

	it("stages [transcribe, judge] judges the asr stage only", async () => {
		const r = await run(processSample({ sample, entities, stages: ["transcribe", "judge"] }));
		expect(r.asrMetrics.entityVerdicts.every((v) => v.source === "judge")).toBe(true);
		expect(r.correctedMetrics).toBeUndefined();
		expect(r.editVerdicts).toEqual([]);
	});

	it("rejects an inconsistent selection before any port call", async () => {
		const cases: readonly (readonly RunStage[])[] = [
			["cleanup", "transcribe"],
			["transcribe", "transcribe"],
			["judge"],
			[],
		];
		for (const stages of cases) {
			const err = await run(
				processSample({ sample, entities, stages }).pipe(
					Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
				),
			);
			expect(err).toBeInstanceOf(PortError);
			expect(String((err as PortError).message)).toContain("invalid stage selection");
		}
	});

	it("rejects an unknown stage id at runtime", async () => {
		const err = await run(
			processSample({ sample, entities, stages: ["bogus" as never, "transcribe"] }).pipe(
				Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain('unknown run stage "bogus"');
	});

	it("stage runners refuse to run without their inputs", async () => {
		const empty = {} as unknown as Parameters<(typeof RUN_STAGE_FNS)["cleanup"]>[0];
		for (const stage of ["cleanup", "judge"] as const) {
			const err = await run(
				RUN_STAGE_FNS[stage](empty).pipe(
					Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
				),
			);
			expect(err).toBeInstanceOf(PortError);
			expect(String((err as PortError).message)).toContain("requires");
		}
	});
});

describe("priorAsrText (P-077 cross-suite inputs)", () => {
	const PRIOR = "textoasr anterior do paciente";

	it("runStageSelection allows a transcribe-less selection when required", () => {
		expect(() => runStageSelection(["cleanup", "judge"])).toThrow(/require "transcribe"/);
		expect(runStageSelection(["cleanup", "judge"], { requireTranscribe: false })).toEqual([
			"cleanup",
			"judge",
		]);
	});

	it("consumes prior ASR text in place of transcribe — no ASR call, empty confSegments", async () => {
		let asrCalled = false;
		const noAsr = Layer.succeed(
			AsrPort,
			AsrPort.of({
				egress: false,
				transcribe: () =>
					Effect.sync(() => {
						asrCalled = true;
						return { asr: asrResult, record };
					}),
			}),
		);
		const r = await Effect.runPromise(
			Effect.provide(
				processSample({
					sample,
					entities,
					stages: ["cleanup", "judge"],
					priorAsrText: PRIOR,
				}),
				Layer.mergeAll(live, noAsr),
			),
		);
		expect(asrCalled).toBe(false);
		expect(r.asr.text).toBe(PRIOR);
		expect(r.corrected).toBeDefined();
		expect(r.correctedMetrics).toBeDefined();
		expect(r.confSegments).toEqual([]);
		// Metrics still compare prior text against the script honestly.
		expect(r.asrMetrics.wer).toBeGreaterThan(0);
		// No transcribe-stage audit record — no call happened.
		expect(r.records.every((rec) => rec.stage !== "transcribe")).toBe(true);
	});

	it("rejects priorAsrText together with a live transcribe selection", async () => {
		const err = await run(
			processSample({
				sample,
				entities,
				stages: ["transcribe", "cleanup"],
				priorAsrText: PRIOR,
			}).pipe(Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e))),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain('"transcribe" is selected');
	});

	it("rejects priorAsrText with the default (full) stage selection", async () => {
		const err = await run(
			processSample({ sample, entities, priorAsrText: PRIOR }).pipe(
				Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("pick one");
	});

	it("a transcribe-less selection without prior text still fails validation", async () => {
		const err = await run(
			processSample({ sample, entities, stages: ["cleanup", "judge"] }).pipe(
				Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e)),
			),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("invalid stage selection");
	});

	it("untrusted samples re-gate prior ASR text — residuals fail closed", async () => {
		const real: Sample = {
			...sample,
			script: "paciente cpf 123.456.789-00 nega febre",
			origin: "real_anonymized",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		const err = await run(
			processSample({
				sample: real,
				entities,
				stages: ["cleanup"],
				// 14-digit run survives every scrub pattern → gate null.
				priorAsrText: "registro interno 20240102030405 do paciente",
			}).pipe(Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e))),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("prior ASR text");
	});

	it("untrusted samples get prior ASR text scrubbed before stages see it", async () => {
		const llmInputs: string[] = [];
		const captureLlm = Layer.succeed(
			LlmPort,
			LlmPort.of({
				egress: false,
				generate: () => Effect.succeed({ text: "x", record }),
				correct: (env) =>
					Effect.sync(() => {
						llmInputs.push(env.input);
						return { edits: { ops: [] }, record };
					}),
			}),
		);
		const real: Sample = {
			...sample,
			script: "paciente cpf 123.456.789-00 nega febre",
			origin: "real_anonymized",
			provenance: {
				sourcePartner: "clinic-x",
				anonymizationMethod: "phi-scrub-v1",
				consentRef: "consent-1",
				lgpdBasis: "legitimate_interest",
			},
		};
		const r = await Effect.runPromise(
			Effect.provide(
				processSample({
					sample: real,
					entities,
					stages: ["cleanup"],
					priorAsrText: "paciente cpf 123.456.789-00 nega febre",
				}),
				Layer.mergeAll(live, captureLlm),
			),
		);
		expect(llmInputs[0]).toContain("[CPF]");
		expect(llmInputs[0]).not.toContain("123.456.789-00");
		expect(r.asr.text).toContain("[CPF]");
	});
});

describe("domainParams (P-079)", () => {
	it("entityCategories restricts the scored gold entities", async () => {
		const r = await run(
			processSample({ sample, entities, domainParams: { entityCategories: ["medication"] } }),
		);
		expect(r.asrMetrics.entityVerdicts.map((v) => v.category)).toEqual(["medication"]);
		expect(r.correctedMetrics!.entityVerdicts.map((v) => v.category)).toEqual(["medication"]);
	});

	it("absent entityCategories scores every entity", async () => {
		const r = await run(processSample({ sample, entities, domainParams: {} }));
		expect(r.asrMetrics.entityVerdicts).toHaveLength(2);
	});

	it("a malformed entityCategories fails the sample honestly", async () => {
		const err = await run(
			processSample({
				sample,
				entities,
				domainParams: { entityCategories: "medication" },
			}).pipe(Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e))),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("entityCategories");
	});

	it("cleanupTimestamps sends the corrector [m:ss] segments (T-207)", async () => {
		// The stub corrector edits env.input[0] — "[" under timestamps
		// mode vs "o" flat. "[" never anchors onto the plain transcript,
		// so the run's corrected text stays the raw ASR text — proof the
		// corrector saw the timestamped rendering, not asr.text.
		const r = await run(
			processSample({
				sample,
				entities,
				domainParams: { cleanupTimestamps: true },
			}),
		);
		expect(r.corrected).toBe(r.asr.text);
		expect(r.edits?.ops).toEqual([]);
	});

	it("absent cleanupTimestamps keeps the flat corrector input", async () => {
		const r = await run(processSample({ sample, entities, domainParams: {} }));
		expect(r.corrected!.startsWith("O")).toBe(true);
	});

	it("a malformed cleanupTimestamps fails the sample honestly", async () => {
		const err = await run(
			processSample({
				sample,
				entities,
				domainParams: { cleanupTimestamps: "yes" },
			}).pipe(Effect.catchTag("PortError", (e: PortError) => Effect.succeed(e))),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(String((err as PortError).message)).toContain("cleanupTimestamps");
	});
});

describe("evalRunPack (@ktb/pipeline adapter)", () => {
	it("mirrors the stage selection into the def and keeps every impl", () => {
		const pack = evalRunPack(["cleanup", "judge"]);
		expect(pack.def.id).toBe(EVAL_RUN_PIPELINE_ID);
		expect(pack.def.stages.map((s) => s.id)).toEqual(["cleanup", "judge"]);
		// All three implementations ship in the pack — the def selects
		// the subset (register() only requires def entries ⊆ stages).
		expect(Object.keys(pack.stages).sort()).toEqual(["cleanup", "judge", "transcribe"]);
	});

	it("stage failures surface as PipelineRunError carrying the original PortError", async () => {
		const registry = makePipelineRegistry();
		registry.register(evalRunPack(["cleanup"]));
		const ctx = {} as unknown as Parameters<(typeof RUN_STAGE_FNS)["cleanup"]>[0];
		const outcome = await Effect.runPromise(
			registry.run(EVAL_RUN_PIPELINE_ID, ctx).pipe(Effect.catch((e) => Effect.succeed(e))),
		);
		expect(outcome).toBeInstanceOf(PipelineRunError);
		if (outcome instanceof PipelineRunError) {
			// The registry wraps twice (PipelineStageError → run error);
			// `cause` is the ORIGINAL typed error processSample unwraps.
			expect(outcome.cause).toBeInstanceOf(PortError);
			expect(outcome.stageId).toBe("cleanup");
			expect(outcome.trace).toEqual([
				expect.objectContaining({ stageId: "cleanup", status: "failed" }),
			]);
		}
	});
});
