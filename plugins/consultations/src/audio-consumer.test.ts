import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { EventBus, type EventBusShape } from "@effect-server-utils/cqrs";

import * as Effect from "effect/Effect";

import { makeDb, Db, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { consultations, jobRuns } from "@ktb/db/schema";
import { jobHandlers, registerJobHandler } from "@ktb/jobs-port";
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";
import type { AudioJobMessage } from "@ktb/server-fns";

import { AUDIO_TRANSCRIPTION_JOB_KIND, attachAudioRecord } from "./audio-jobs.ts";
import {
	bytesToBase64,
	defaultAudioJobDeps,
	extractWhisperResult,
	extractWhisperText,
	handleAudioQueueBatch,
	MAX_AUDIO_BYTES,
	normalizeAudioJobBody,
	processAudioJob,
	transcribeAudio,
	WHISPER_CLINICAL_PROMPT,
	whisperInputs,
	type AudioJobDeps,
	type QueueMessageLike,
	type WhisperSegment,
} from "./audio-consumer.ts";
import { createConsultation } from "./lifecycle.ts";

const DDL = `
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, patient_id INTEGER, transcript TEXT NOT NULL, anamnesis TEXT, review TEXT, engine TEXT, source TEXT NOT NULL DEFAULT 'browser', status TEXT NOT NULL DEFAULT 'done', bot_id TEXT, consent_at INTEGER, audio_key TEXT, audio_status TEXT NOT NULL DEFAULT 'none', audio_content_type TEXT, audio_size INTEGER, audio_error TEXT, server_transcript TEXT, corrected_transcript TEXT, enhancement_engine TEXT, anamnesis_hash TEXT, anamnesis_version INTEGER, blob_hash TEXT, synthetic INTEGER NOT NULL DEFAULT 0, eval_item_id INTEGER, created_at INTEGER NOT NULL, tenant_id INTEGER);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE job_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', payload_ref TEXT, error TEXT, tenant_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO groups (id, name, slug, kind, zk) VALUES (9, 'ZK Clinic', 'zk', 'clinic', 1);
`;

const TEST_MODEL = "test-whisper";

const makeDeps = (over: Partial<AudioJobDeps> = {}) => {
	const db = makeDb(makeD1(DDL));
	const calls = {
		corrected: [] as string[],
		segments: [] as (readonly WhisperSegment[] | undefined)[],
	};
	const deps: AudioJobDeps = {
		db,
		model: TEST_MODEL,
		bucket: {
			get: async (key) => {
				const objects: Record<string, { size: number; data: Uint8Array }> = {
					"audio/u1/1/a.webm": { size: 3, data: new Uint8Array([1, 2, 3]) },
				};
				const o = objects[key];
				if (!o) return null;
				const bytes = o.data.slice();
				return { size: o.size, arrayBuffer: async () => bytes.buffer };
			},
		},
		ai: { run: async () => ({ text: "transcrição servidor" }) },
		correctTranscript: async (input) => {
			calls.corrected.push(input.text);
			calls.segments.push(input.segments);
			return { corrected: `${input.text} (corrigido)`, engine: "test-llm" };
		},
		...over,
	};
	return { db, deps, calls };
};

const job = (consultationId: number, over: Partial<AudioJobMessage> = {}): AudioJobMessage => ({
	consultationId,
	audioKey: "audio/u1/1/a.webm",
	userId: "u1",
	...over,
});

const row = async (db: DbClient, id: number) =>
	(await db.select().from(consultations).where(eq(consultations.id, id)))[0];

/** Canonical PL-007 wire envelope around an audio payload. */
const envelope = (j: AudioJobMessage, id = "env-1"): unknown => ({
	id,
	kind: AUDIO_TRANSCRIPTION_JOB_KIND,
	payload: j,
	tenantId: j.tenantId ?? null,
});

const jobRun = async (db: DbClient, id: string) =>
	(await db.select().from(jobRuns).where(eq(jobRuns.id, id)))[0];

describe("audio-consumer pure helpers", () => {
	it("bytesToBase64 round-trips", () => {
		const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
		expect(atob(bytesToBase64(bytes))).toBe("hello");
	});

	it("whisperInputs sends base64 audio with pt language and clinical prompt", () => {
		expect(whisperInputs("QUJD")).toEqual({
			audio: "QUJD",
			language: "pt",
			initial_prompt: WHISPER_CLINICAL_PROMPT,
			vad_filter: true,
			condition_on_previous_text: false,
		});
	});

	it("extractWhisperResult keeps timed segments and tolerates shapes", () => {
		expect(extractWhisperResult({ text: "oi" })).toEqual({ text: "oi" });
		expect(extractWhisperResult("raw")).toEqual({ text: "raw" });
		expect(
			extractWhisperResult({
				text: "fala um. fala dois.",
				segments: [
					{ start: 0, end: 1.5, text: "fala um." },
					{ start: 1.5, end: 3, text: "fala dois." },
				],
			}),
		).toEqual({
			text: "fala um. fala dois.",
			segments: [
				{ start: 0, end: 1.5, text: "fala um." },
				{ start: 1.5, end: 3, text: "fala dois." },
			],
		});
		// Malformed entries drop out; a non-array segments key is ignored.
		expect(
			extractWhisperResult({
				text: "t",
				segments: [
					{ start: 0, end: 1, text: "ok" },
					{ start: "x", end: 1, text: "bad" },
					{ start: 0, end: Number.NaN, text: "nan" },
					{ start: 0, end: 1 },
					{ start: 0, end: 1, text: 42 },
					"junk",
				],
			}).segments,
		).toEqual([{ start: 0, end: 1, text: "ok" }]);
		expect(extractWhisperResult({ text: "t", segments: "nope" })).toEqual({ text: "t" });
		expect(() => extractWhisperResult({ nope: 1 })).toThrow("unrecognized");
		expect(() => extractWhisperResult(null)).toThrow("unrecognized");
		expect(() => extractWhisperResult(42)).toThrow("unrecognized");
	});

	it("extractWhisperText tolerates shapes", () => {
		expect(extractWhisperText({ text: "oi" })).toBe("oi");
		expect(extractWhisperText({ transcription: "alt" })).toBe("alt");
		expect(extractWhisperText("raw")).toBe("raw");
		expect(extractWhisperText({ text: "t", segments: [{ start: 0, end: 1, text: "s" }] })).toBe(
			"t",
		);
		expect(() => extractWhisperText({ nope: 1 })).toThrow("unrecognized");
		expect(() => extractWhisperText(null)).toThrow("unrecognized");
		expect(() => extractWhisperText(42)).toThrow("unrecognized");
	});

	it("transcribeAudio calls the given model with whisper inputs", async () => {
		const seen: { model?: string; inputs?: unknown } = {};
		const ai = {
			run: async (model: string, inputs: unknown) => {
				seen.model = model;
				seen.inputs = inputs;
				return { text: "fala" };
			},
		};
		const result = await transcribeAudio(ai, new Uint8Array([65, 66]), TEST_MODEL);
		expect(result).toEqual({ text: "fala" });
		expect(seen.model).toBe(TEST_MODEL);
		expect((seen.inputs as { audio: string }).audio).toBeTruthy();
	});

	it("transcribeAudio surfaces provider segments", async () => {
		const ai = {
			run: async () => ({
				text: "um dois",
				segments: [{ start: 0, end: 0.5, text: "um" }],
			}),
		};
		const result = await transcribeAudio(ai, new Uint8Array([65]), TEST_MODEL);
		expect(result.segments).toEqual([{ start: 0, end: 0.5, text: "um" }]);
	});
});

describe("processAudioJob", () => {
	it("transcribes, stores server transcript and runs LLM cleanup", async () => {
		const { db, deps, calls } = makeDeps();
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });

		await processAudioJob(job(id), deps);

		const r = await row(db, id);
		expect(r?.audioStatus).toBe("done");
		expect(r?.serverTranscript).toBe("transcrição servidor");
		expect(r?.correctedTranscript).toBe("transcrição servidor (corrigido)");
		expect(r?.enhancementEngine).toBe("test-llm");
		expect(calls.corrected).toEqual(["transcrição servidor"]);
		expect(calls.segments).toEqual([undefined]); // text-only provider response
	});

	it("forwards provider segments to the cleanup dep and audits the count", async () => {
		const entries: Parameters<NonNullable<AudioJobDeps["recordAudit"]>>[0][] = [];
		const { db, deps, calls } = makeDeps({
			ai: {
				run: async () => ({
					text: "um dois",
					segments: [
						{ start: 0, end: 0.5, text: "um" },
						{ start: 0.5, end: 1, text: "dois" },
					],
				}),
			},
			recordAudit: async (e) => {
				entries.push(e);
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });

		await processAudioJob(job(id), deps);

		expect(calls.segments).toEqual([
			[
				{ start: 0, end: 0.5, text: "um" },
				{ start: 0.5, end: 1, text: "dois" },
			],
		]);
		expect(entries).toEqual([
			{
				action: "consultations.transcription.completed",
				targetType: "consultation",
				targetId: id,
				tenantId: null,
				detail: { segments: 2 },
			},
		]);
	});

	it("refuses to send zero-knowledge audio to Whisper (T-147)", async () => {
		let aiCalled = false;
		const { db, deps } = makeDeps({
			ai: {
				run: async () => {
					aiCalled = true;
					return { text: "x" };
				},
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }, 9))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id, { tenantId: 9 }), deps);
		const r = await row(db, id);
		expect(aiCalled).toBe(false);
		expect(r?.audioStatus).toBe("failed");
		expect(r?.audioError).toContain("zero-knowledge");
		expect(r?.serverTranscript).toBeNull();
	});

	it("is idempotent — done consultations are skipped", async () => {
		const { db, deps } = makeDeps();
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id), deps);
		await processAudioJob(job(id), deps); // redelivery
		const r = await row(db, id);
		expect(r?.serverTranscript).toBe("transcrição servidor");
	});

	it("marks failed when the audio object is missing", async () => {
		const { db, deps } = makeDeps();
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/missing.webm", size: 3 });
		await processAudioJob(job(id), deps);
		const r = await row(db, id);
		expect(r?.audioStatus).toBe("failed");
		expect(r?.audioError).toContain("missing");
	});

	it("marks failed on oversized audio without calling the model", async () => {
		const { db, deps } = makeDeps({
			bucket: {
				get: async () => ({
					size: MAX_AUDIO_BYTES + 1,
					arrayBuffer: async () => new ArrayBuffer(0),
				}),
			},
			ai: {
				run: async () => {
					throw new Error("should not be called");
				},
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id), deps);
		const r = await row(db, id);
		expect(r?.audioStatus).toBe("failed");
		expect(r?.audioError).toContain("too large");
	});

	it("marks failed on owner mismatch and on AI errors", async () => {
		const { db, deps } = makeDeps();
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id, { userId: "u2" }), deps);
		expect((await row(db, id))?.audioError).toContain("mismatch");

		const failing = makeDeps({
			db,
			ai: {
				run: async () => {
					throw new Error("ai down");
				},
			},
		});
		const id2 = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id2, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id2), failing.deps);
		const r2 = await row(db, id2);
		expect(r2?.audioStatus).toBe("failed");
		expect(r2?.audioError).toContain("ai down");
	});

	it("publishes live audio updates for the jobs feed", async () => {
		const updates: {
			consultationId: number;
			audioStatus: string;
			audioError: string | null;
			tenantId: number | null;
		}[] = [];
		const { db, deps } = makeDeps({
			publishAudioUpdate: async (u) => {
				updates.push(u);
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });

		await processAudioJob(job(id), deps);
		expect(updates).toEqual([
			{ consultationId: id, audioStatus: "processing", audioError: null, tenantId: null },
			{ consultationId: id, audioStatus: "done", audioError: null, tenantId: null },
		]);
	});

	it("forwards the row's tenant_id on live updates — the payload hint only covers missing rows", async () => {
		const updates: { tenantId: number | null }[] = [];
		const { db, deps } = makeDeps({
			publishAudioUpdate: async (u) => {
				updates.push(u);
			},
		});
		// Row owned by tenant 7; the message claims tenant 9 — the row wins.
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }, 7))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id, { tenantId: 9 }), deps);
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.every((u) => u.tenantId === 7)).toBe(true);

		// Missing row: the payload's tenantId is the only scope signal.
		updates.length = 0;
		await processAudioJob(job(424242, { tenantId: 9 }), deps);
		expect(updates).toEqual([
			{
				consultationId: 424242,
				audioStatus: "failed",
				audioError: "consultation not found",
				tenantId: 9,
			},
		]);
	});

	it("publishes the failure reason and survives a broken publisher", async () => {
		const updates: { audioStatus: string; audioError: string | null }[] = [];
		const { db, deps } = makeDeps({
			publishAudioUpdate: async (u) => {
				updates.push(u);
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/missing.webm", size: 3 });
		await processAudioJob(job(id), deps);
		expect(updates.at(-1)).toMatchObject({ audioStatus: "failed" });
		expect(updates.at(-1)?.audioError).toContain("missing");

		// A rejecting publisher must not fail the job.
		const { db: db2, deps: deps2 } = makeDeps({
			publishAudioUpdate: async () => {
				throw new Error("bus down");
			},
		});
		const id2 = (await createConsultation(db2, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db2, id2, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id2), deps2);
		expect((await row(db2, id2))?.audioStatus).toBe("done");
	});

	it("falls back to the job's audio key when the row has none", async () => {
		const { db, deps } = makeDeps();
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await processAudioJob(job(id), deps);
		expect((await row(db, id))?.audioStatus).toBe("done");
	});

	it("marks failed when neither the row nor the job carries an audio key", async () => {
		const { db, deps } = makeDeps();
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await processAudioJob(job(id, { audioKey: "" }), deps);
		const r = await row(db, id);
		expect(r?.audioStatus).toBe("failed");
		expect(r?.audioError).toBe("no audio key recorded");
	});

	it.each([
		["bucket", { bucket: undefined }],
		["ai binding", { ai: undefined }],
	] as const)("marks failed when the %s is not configured", async (_name, over) => {
		const { db, deps } = makeDeps(over);
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id), deps);
		const r = await row(db, id);
		expect(r?.audioStatus).toBe("failed");
		expect(r?.audioError).toBe("audio pipeline not configured");
	});

	it("marks failed when the transcription comes back empty", async () => {
		const { db, deps, calls } = makeDeps({ ai: { run: async () => ({ text: "   " }) } });
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id), deps);
		const r = await row(db, id);
		expect(r?.audioStatus).toBe("failed");
		expect(r?.audioError).toBe("transcription returned empty text");
		expect(calls.corrected).toEqual([]);
	});

	it("keeps only the original transcript when cleanup yields nothing", async () => {
		const { db, deps } = makeDeps({ correctTranscript: async () => null });
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id), deps);
		const r = await row(db, id);
		expect(r?.audioStatus).toBe("done");
		expect(r?.correctedTranscript).toBeNull();
	});

	it("keeps status done when LLM cleanup fails", async () => {
		const { db, deps } = makeDeps({
			correctTranscript: async () => {
				throw new Error("llm down");
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id), deps);
		const r = await row(db, id);
		expect(r?.audioStatus).toBe("done");
		expect(r?.correctedTranscript).toBeNull();
	});
});

describe("transcription audit trail (P-080)", () => {
	type AuditEntry = Parameters<NonNullable<AudioJobDeps["recordAudit"]>>[0];

	it("records a completed event on success", async () => {
		const entries: AuditEntry[] = [];
		const { db, deps } = makeDeps({
			recordAudit: async (e) => {
				entries.push(e);
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }, 4))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });

		await processAudioJob(job(id), deps);

		expect(entries).toEqual([
			{
				action: "consultations.transcription.completed",
				targetType: "consultation",
				targetId: id,
				tenantId: 4,
				detail: { segments: 0 }, // default mock returns text only
			},
		]);
	});

	it("records failed with the coarse reason when the provider errors", async () => {
		const entries: AuditEntry[] = [];
		const { db, deps } = makeDeps({
			ai: {
				run: async () => {
					throw new Error("provider internals: quota exceeded");
				},
			},
			recordAudit: async (e) => {
				entries.push(e);
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });

		await processAudioJob(job(id), deps);

		expect(entries).toEqual([
			{
				action: "consultations.transcription.failed",
				targetType: "consultation",
				targetId: id,
				tenantId: null,
				detail: { reason: "transcription failed" },
			},
		]);
		// The row keeps the raw reason; only the audit detail is coerced.
		expect((await row(db, id))?.audioError).toContain("provider internals");
	});

	it("records failed with the literal reason on fixed-string paths", async () => {
		const entries: AuditEntry[] = [];
		const { deps } = makeDeps({
			recordAudit: async (e) => {
				entries.push(e);
			},
		});
		// Missing row: tenantId falls back to the payload's tenant_id.
		await processAudioJob(job(424242, { tenantId: 9 }), deps);
		expect(entries).toEqual([
			{
				action: "consultations.transcription.failed",
				targetType: "consultation",
				targetId: 424242,
				tenantId: 9,
				detail: { reason: "consultation not found" },
			},
		]);
	});

	it("survives a rejecting audit hook on both outcomes", async () => {
		const { db, deps } = makeDeps({
			recordAudit: async () => {
				throw new Error("audit down");
			},
		});
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		await processAudioJob(job(id), deps);
		expect((await row(db, id))?.audioStatus).toBe("done");

		const id2 = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id2, { audioKey: "audio/u1/1/missing.webm", size: 3 });
		await processAudioJob(job(id2), deps);
		expect((await row(db, id2))?.audioStatus).toBe("failed");
	});
});

describe("defaultAudioJobDeps", () => {
	it("resolves bindings from the server runtime and Db from the app runtime", async () => {
		const db = makeDb(makeD1(DDL));
		const bucket = { get: async () => null };
		const ai = { run: async () => ({}) };
		const correct = async () => null;
		setServerRuntime({
			run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
				Effect.runPromise(
					(effect as Effect.Effect<A, E, never>).pipe(Effect.provideService(Db, db)),
				),
			runAs: () => Promise.reject(new Error("unused")),
			audio: bucket,
			ai,
			audioTranscribeModel: "runtime-model",
			getLocale: () => "en",
		} as unknown as ServerRuntime);
		try {
			const deps = await defaultAudioJobDeps(correct);
			expect(deps.db).toBe(db);
			expect(deps.bucket).toBe(bucket);
			expect(deps.ai).toBe(ai);
			expect(deps.model).toBe("runtime-model");
			expect(deps.correctTranscript).toBe(correct);
		} finally {
			resetServerRuntime();
		}
	});
});

describe("normalizeAudioJobBody", () => {
	it("decodes envelopes and legacy payloads, rejects the rest", () => {
		const j = job(1);
		expect(normalizeAudioJobBody(envelope(j, "e1"))).toEqual({
			kind: AUDIO_TRANSCRIPTION_JOB_KIND,
			payload: j,
			id: "e1",
			tenantId: null,
		});
		expect(normalizeAudioJobBody({ ...j, tenantId: 4 })).toEqual({
			kind: AUDIO_TRANSCRIPTION_JOB_KIND,
			payload: { ...j, tenantId: 4 },
			tenantId: 4,
		});
		expect(normalizeAudioJobBody({ bogus: true })).toBeNull();
		expect(normalizeAudioJobBody({ kind: AUDIO_TRANSCRIPTION_JOB_KIND })).toBeNull();
		expect(normalizeAudioJobBody("nope")).toBeNull();
	});
});

describe("handleAudioQueueBatch", () => {
	// The consumer's `run` goes through the @ktb/server-fns runtime
	// registry: a minimal fake executes effects directly (Db is not
	// needed — deps carry it; EventBus-dependent side effects degrade
	// to the same caught failures as a missing bus).
	beforeAll(() => {
		setServerRuntime({
			run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
				Effect.runPromise(effect as Effect.Effect<A, E, never>),
			runAs: () => Promise.reject(new Error("unused")),
			audioTranscribeModel: TEST_MODEL,
			getLocale: () => "en",
		} as unknown as ServerRuntime);
	});
	afterAll(() => {
		resetServerRuntime();
	});

	const msg = (body: unknown, log: string[]): QueueMessageLike => ({
		body,
		ack: () => log.push("ack"),
		retry: () => log.push("retry"),
	});

	it("acks valid jobs and poison messages, retries on unexpected errors", async () => {
		const { db, deps } = makeDeps();
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		const log: string[] = [];
		await handleAudioQueueBatch(
			[
				msg(envelope(job(id), "env-ok"), log),
				msg({ bogus: true }, log),
				msg(envelope(job(99999), "env-missing"), log), // missing consultation → marked failed, acked
			],
			deps,
		);
		expect(log).toEqual(["ack", "ack", "ack"]);
		expect((await row(db, id))?.audioStatus).toBe("done");
		// job_runs projection: delivered jobs land "done" (the domain row
		// carries the audio-specific failure for the missing consultation).
		expect((await jobRun(db, "env-ok"))?.status).toBe("done");
		expect((await jobRun(db, "env-missing"))?.status).toBe("done");
		expect(await jobRun(db, "bogus")).toBeUndefined();
	});

	it("accepts tenant_id on the message and still acks pre-tenancy payloads", async () => {
		const { db, deps } = makeDeps();
		const id = (await createConsultation(db, { userId: "u1", source: "browser" }, 4))!;
		await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
		const log: string[] = [];
		await handleAudioQueueBatch(
			[
				// New shape: explicit tenant_id.
				msg(envelope({ ...job(id), tenantId: 4 }, "env-tenant"), log),
				// Old shape: no tenant_id — decodes as personal scope.
				msg(job(id), log),
			],
			deps,
		);
		expect(log).toEqual(["ack", "ack"]);
		expect((await row(db, id))?.audioStatus).toBe("done");
		expect((await jobRun(db, "env-tenant"))?.tenantId).toBe(4);
	});

	it("acks malformed envelopes, non-object bodies and unknown kinds", async () => {
		const { db, deps } = makeDeps();
		const log: string[] = [];
		await handleAudioQueueBatch(
			[
				msg({ kind: AUDIO_TRANSCRIPTION_JOB_KIND }, log), // envelope missing id → poison
				msg("not json at all", log),
				msg({ id: "u1", kind: "no.such.kind", payload: {} }, log),
			],
			deps,
		);
		expect(log).toEqual(["ack", "ack", "ack"]);
		expect((await jobRun(db, "u1"))?.error).toBe("unknown job kind: no.such.kind");
	});

	it("dispatches registered kinds through the shared registry", async () => {
		const { db, deps } = makeDeps();
		const seen: unknown[] = [];
		registerJobHandler("test.ping", {
			handle: async (payload) => {
				seen.push(payload);
			},
		});
		try {
			const log: string[] = [];
			await handleAudioQueueBatch(
				[msg({ id: "ping-1", kind: "test.ping", payload: { hi: 1 } }, log)],
				deps,
				jobHandlers,
			);
			expect(log).toEqual(["ack"]);
			expect(seen).toEqual([{ hi: 1 }]);
			expect((await jobRun(db, "ping-1"))?.status).toBe("done");
		} finally {
			delete jobHandlers["test.ping"];
		}
	});

	it("retries when processing throws unexpectedly", async () => {
		const { deps } = makeDeps({
			db: {
				// break audioJobRecord's first query
			} as unknown as DbClient,
		});
		const log: string[] = [];
		await handleAudioQueueBatch([msg(job(1), log)], deps);
		expect(log).toEqual(["retry"]);
	});

	it("dispatches ConsultationAudioUpdated through a bound EventBus", async () => {
		const dispatched: { _tag?: string }[] = [];
		const bus = {
			dispatch: (events: readonly { _tag?: string }[]) =>
				Effect.sync(() => {
					dispatched.push(...events);
				}),
		} as unknown as EventBusShape;
		setServerRuntime({
			run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
				Effect.runPromise(
					Effect.provideService(effect as Effect.Effect<A, E, never>, EventBus, bus),
				),
			runAs: () => Promise.reject(new Error("unused")),
			audioTranscribeModel: TEST_MODEL,
			getLocale: () => "en",
		} as unknown as ServerRuntime);
		try {
			const { db, deps } = makeDeps();
			const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
			await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
			const log: string[] = [];
			// deps carry no publishAudioUpdate — withSideEffectDefaults
			// wires the production default, which dispatches on the bus.
			await handleAudioQueueBatch([msg(envelope(job(id), "env-bus"), log)], deps);
			expect(log).toEqual(["ack"]);
			// processing + done notifications both reached the bus.
			expect(dispatched.length).toBeGreaterThanOrEqual(2);
			expect(dispatched.every((e) => e._tag === "consultation.audioUpdated")).toBe(true);
		} finally {
			setServerRuntime({
				run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
					Effect.runPromise(effect as Effect.Effect<A, E, never>),
				runAs: () => Promise.reject(new Error("unused")),
				audioTranscribeModel: TEST_MODEL,
				getLocale: () => "en",
			} as unknown as ServerRuntime);
		}
	});

	it("keeps caller deps untouched when no server runtime is bound", async () => {
		resetServerRuntime();
		try {
			const { db, deps } = makeDeps();
			const id = (await createConsultation(db, { userId: "u1", source: "browser" }))!;
			await attachAudioRecord(db, id, { audioKey: "audio/u1/1/a.webm", size: 3 });
			const log: string[] = [];
			// withSideEffectDefaults returns deps as-is (no publish/audit
			// defaults); `run` then fails without a runtime → the message
			// is retried rather than poisoned.
			await handleAudioQueueBatch([msg(job(id), log)], deps);
			expect(log).toEqual(["retry"]);
		} finally {
			setServerRuntime({
				run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
					Effect.runPromise(effect as Effect.Effect<A, E, never>),
				runAs: () => Promise.reject(new Error("unused")),
				audioTranscribeModel: TEST_MODEL,
				getLocale: () => "en",
			} as unknown as ServerRuntime);
		}
	});
});
