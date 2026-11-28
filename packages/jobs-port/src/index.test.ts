import { describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import {
	decodeJobEnvelope,
	dispatchJobInline,
	getJobRun,
	insertJobRun,
	JobEnvelopeSchema,
	JobRecordSchema,
	JobStatusSchema,
	Jobs,
	JobsLive,
	listJobRuns,
	makeJobConsumer,
	makeJobHandlerRegistry,
	makeJobs,
	queueSend,
	QUEUE_MAX_DELAY_SECONDS,
	upsertJobRun,
	type JobEnvelope,
	type JobRecord,
	type JobMessageLike,
	type JobRegistration,
} from "./index.ts";

const makeTestDb = () => {
	const sql = makeTestD1();
	return { sql, db: makeDb(sql) };
};

const msg = (body: unknown, log: string[]): JobMessageLike => ({
	body,
	ack: () => log.push("ack"),
	retry: () => log.push("retry"),
});

describe("envelope + record schemas", () => {
	it("decodes a full envelope and tolerates absent/null tenantId", () => {
		expect(decodeJobEnvelope({ id: "j1", kind: "k", payload: { a: 1 }, tenantId: 7 })).toEqual({
			kind: "k",
			payload: { a: 1 },
			id: "j1",
			tenantId: 7,
		});
		// TenantId is string | number (@ktb/tenant): string ids decode
		// verbatim — the projection normalizes them at write time.
		expect(decodeJobEnvelope({ id: "j1", kind: "k", tenantId: "clinic-9" })).toEqual({
			kind: "k",
			payload: undefined,
			id: "j1",
			tenantId: "clinic-9",
		});
		expect(decodeJobEnvelope({ id: "j1", kind: "k", payload: null, tenantId: null })).toEqual({
			kind: "k",
			payload: null,
			id: "j1",
			tenantId: null,
		});
		expect(decodeJobEnvelope({ id: "j1", kind: "k" })).toEqual({
			kind: "k",
			payload: undefined,
			id: "j1",
			tenantId: null,
		});
	});

	it("rejects malformed envelopes", () => {
		expect(decodeJobEnvelope(null)).toBeNull();
		expect(decodeJobEnvelope("nope")).toBeNull();
		expect(decodeJobEnvelope({ kind: "k" })).toBeNull(); // missing id
		expect(decodeJobEnvelope({ id: "j", kind: "" })).toBeNull(); // empty kind
		expect(decodeJobEnvelope({ id: "j", kind: "k", tenantId: true })).toBeNull();
		expect(decodeJobEnvelope({ id: "j", kind: "k", tenantId: { id: 1 } })).toBeNull();
	});

	it("JobEnvelopeSchema/JobRecordSchema round-trip through decodeUnknownSync", () => {
		const decodeEnvelope = Schema.decodeUnknownSync(JobEnvelopeSchema);
		expect(decodeEnvelope({ id: "j", kind: "k", payload: 1 })).toMatchObject({
			id: "j",
			kind: "k",
		});
		const decodeRecord = Schema.decodeUnknownSync(JobRecordSchema);
		const row = {
			id: "j1",
			kind: "k",
			status: "done",
			payloadRef: null,
			error: null,
			tenantId: null,
			createdAt: 1,
			updatedAt: 2,
		};
		expect(decodeRecord(row)).toEqual(row);
		expect(() => decodeRecord({ ...row, status: "bogus" })).toThrow('Expected "queued"');
	});

	it("JobStatusSchema accepts exactly the four job statuses", () => {
		const decode = Schema.decodeUnknownSync(JobStatusSchema);
		for (const status of ["queued", "processing", "done", "failed"] as const) {
			expect(decode(status)).toBe(status);
		}
		expect(() => decode("bogus")).toThrow();
	});
});

describe("job_runs repo helpers", () => {
	it("insertJobRun + getJobRun round-trip; getJobRun misses return null", async () => {
		const { db } = makeTestDb();
		expect(await getJobRun(db, "missing")).toBeNull();
		await insertJobRun(
			db,
			{ id: "j1", kind: "audio", status: "queued", payloadRef: "consultation:1", tenantId: 7 },
			1000,
		);
		expect(await getJobRun(db, "j1")).toEqual({
			id: "j1",
			kind: "audio",
			status: "queued",
			payloadRef: "consultation:1",
			error: null,
			tenantId: 7,
			createdAt: 1000,
			updatedAt: 1000,
		});
	});

	it("upsertJobRun inserts then updates only mutable fields on conflict", async () => {
		const { db } = makeTestDb();
		await upsertJobRun(
			db,
			{ id: "j1", kind: "audio", status: "processing", tenantId: 3, payloadRef: "ref" },
			10,
		);
		await upsertJobRun(
			db,
			{ id: "j1", kind: "audio", status: "done", error: null, tenantId: 99 },
			20,
		);
		expect(await getJobRun(db, "j1")).toEqual({
			id: "j1",
			kind: "audio",
			status: "done",
			payloadRef: "ref", // identity field preserved from the insert
			error: null,
			tenantId: 3, // tenantId is insert-only on conflict
			createdAt: 10,
			updatedAt: 20,
		});
	});

	it("listJobRuns filters by kind/status/tenant and honors limit + ordering", async () => {
		const { db } = makeTestDb();
		await insertJobRun(db, { id: "a", kind: "k1", status: "done" }, 1);
		await insertJobRun(db, { id: "b", kind: "k2", status: "failed", tenantId: 7 }, 2);
		await insertJobRun(db, { id: "c", kind: "k1", status: "queued" }, 3);
		await insertJobRun(db, { id: "d", kind: "cron.a", status: "done" }, 4);
		await insertJobRun(db, { id: "e", kind: "cron.b", status: "failed" }, 5);

		const all = await listJobRuns(db);
		expect(all.map((r) => r.id)).toEqual(["e", "d", "c", "b", "a"]); // newest first
		expect((await listJobRuns(db, { limit: 2 })).map((r) => r.id)).toEqual(["e", "d"]);

		expect((await listJobRuns(db, { kind: "k1" })).map((r) => r.id)).toEqual(["c", "a"]);
		// Prefix match selects every cron.* row regardless of the id suffix.
		expect((await listJobRuns(db, { kindPrefix: "cron." })).map((r) => r.id)).toEqual(["e", "d"]);
		expect(
			(await listJobRuns(db, { kindPrefix: "cron.", status: "done" })).map((r) => r.id),
		).toEqual(["d"]);
		expect((await listJobRuns(db, { status: "failed" })).map((r) => r.id)).toEqual(["e", "b"]);
		expect((await listJobRuns(db, { tenantId: null })).map((r) => r.id)).toEqual([
			"e",
			"d",
			"c",
			"a",
		]);
		expect((await listJobRuns(db, { tenantId: 7 })).map((r) => r.id)).toEqual(["b"]);
		expect(
			(await listJobRuns(db, { kind: "k1", status: "queued", tenantId: null, limit: 1 })).map(
				(r) => r.id,
			),
		).toEqual(["c"]);
	});

	it("normalizes TenantId strings to the integer tenant_id storage form", async () => {
		const { db } = makeTestDb();
		// Numeric strings store as the integer column value; non-numeric
		// strings cannot be stamped and project as personal scope
		// (tenantStorageId contract — same as tenantScopeId).
		await insertJobRun(db, { id: "n", kind: "k", status: "done", tenantId: "7" }, 1);
		await insertJobRun(db, { id: "s", kind: "k", status: "done", tenantId: "clinic-9" }, 2);
		expect(await getJobRun(db, "n")).toMatchObject({ tenantId: 7 });
		expect(await getJobRun(db, "s")).toMatchObject({ tenantId: null });
		// Filters normalize the same way; a non-numeric id matches
		// nothing rather than collapsing onto the personal-scope NULLs.
		expect((await listJobRuns(db, { tenantId: "7" })).map((r) => r.id)).toEqual(["n"]);
		expect(await listJobRuns(db, { tenantId: "clinic-9" })).toEqual([]);
	});
});

describe("makeJobs (enqueue port)", () => {
	it("builds and sends an envelope without a db", async () => {
		const sent: JobEnvelope[] = [];
		const jobs = makeJobs({
			send: async (e) => {
				sent.push(e);
			},
			newId: () => "fixed-id",
		});
		const envelope = await jobs.enqueue("transcription.audio", { n: 1 });
		expect(envelope).toEqual({ id: "fixed-id", kind: "transcription.audio", payload: { n: 1 } });
		expect(sent).toEqual([envelope]);
	});

	it("forwards tenantId and generates ids/timestamps by default", async () => {
		const { db } = makeTestDb();
		const jobs = makeJobs({
			send: async () => ({}),
			db,
			newId: () => "env-1",
			now: () => 500,
		});
		const envelope = await jobs.enqueue("k", "p", { tenantId: null, payloadRef: "ref-1" });
		expect(envelope.tenantId).toBeNull();
		expect(await getJobRun(db, "env-1")).toMatchObject({
			status: "queued",
			payloadRef: "ref-1",
			tenantId: null,
			createdAt: 500,
		});
	});

	it("omits tenantId from the envelope when not provided", async () => {
		const jobs = makeJobs({ send: async () => ({}) });
		const envelope = await jobs.enqueue("k", null);
		expect("tenantId" in envelope).toBe(false);
	});

	it("stamps a finite runAt on the envelope and omits it otherwise", async () => {
		const sent: JobEnvelope[] = [];
		const jobs = makeJobs({
			send: async (e) => {
				sent.push(e);
			},
		});
		const delayed = await jobs.enqueue("k", null, { runAt: 1234.5 });
		expect(delayed.runAt).toBe(1234.5);
		// Non-finite runAt is dropped — the field is advisory, never a
		// reason to emit a corrupt envelope.
		const invalid = await jobs.enqueue("k", null, { runAt: Number.NaN });
		expect("runAt" in invalid).toBe(false);
		expect(sent.map((e) => e.runAt)).toEqual([1234.5, undefined]);
	});

	it("rejects empty kinds before touching transport or projection", async () => {
		const send = vi.fn<(envelope: JobEnvelope) => Promise<unknown>>(async () => ({}));
		const { db } = makeTestDb();
		const jobs = makeJobs({ send, db });
		await expect(jobs.enqueue("", {})).rejects.toThrow("non-empty");
		expect(send).not.toHaveBeenCalled();
		expect(await listJobRuns(db)).toEqual([]);
	});

	it("marks the projection failed and rethrows when send fails", async () => {
		const { db } = makeTestDb();
		const jobs = makeJobs({
			send: async () => {
				throw new Error("queue down");
			},
			db,
			newId: () => "env-fail",
		});
		await expect(jobs.enqueue("k", {}, { tenantId: 2 })).rejects.toThrow("queue down");
		expect(await getJobRun(db, "env-fail")).toMatchObject({
			status: "failed",
			error: "Error: queue down",
			tenantId: 2,
		});
	});

	it("writes tenantId on the failure mark when the projection row is gone", async () => {
		const { sql, db } = makeTestDb();
		const jobs = makeJobs({
			send: async () => {
				// Remove the queued row mid-flight so the failure mark inserts fresh.
				await sql.exec("DELETE FROM job_runs");
				throw new Error("queue down");
			},
			db,
			newId: () => "env-gone",
		});
		await expect(jobs.enqueue("k", {}, { tenantId: 4 })).rejects.toThrow("queue down");
		expect(await getJobRun(db, "env-gone")).toMatchObject({
			status: "failed",
			tenantId: 4,
		});
	});

	it("propagates projection insert failures before anything is sent", async () => {
		const send = vi.fn<(envelope: JobEnvelope) => Promise<unknown>>(async () => ({}));
		const jobs = makeJobs({ send, db: {} as DbClient });
		await expect(jobs.enqueue("k", {})).rejects.toThrow("db.insert");
		expect(send).not.toHaveBeenCalled();
	});

	it("rethrows send failures when no db is bound", async () => {
		const jobs = makeJobs({
			send: async () => {
				throw new Error("queue down");
			},
		});
		await expect(jobs.enqueue("k", {})).rejects.toThrow("queue down");
	});

	it("still throws the send error when the failure-mark write also fails", async () => {
		const { sql, db } = makeTestDb();
		const jobs = makeJobs({
			send: async () => {
				// Drop the projection table mid-flight so the failure mark fails.
				await sql.exec("DROP TABLE job_runs");
				throw new Error("queue down");
			},
			db,
			newId: () => "env-x",
		});
		await expect(jobs.enqueue("k", {})).rejects.toThrow("queue down");
	});
});

describe("JobsLive layer", () => {
	it("exposes the stable service key", () => {
		expect(Jobs.key).toBe("@ktb/jobs-port/Jobs");
	});

	it("provides the Jobs service to Effect programs", async () => {
		const sent: JobEnvelope[] = [];
		const program = Effect.gen(function* () {
			const jobs = yield* Jobs;
			return yield* Effect.promise(() => jobs.enqueue("k", { v: 1 }));
		});
		const envelope = await Effect.runPromise(
			Effect.provide(program, JobsLive({ send: async (e) => void sent.push(e) })),
		);
		expect(envelope.kind).toBe("k");
		expect(sent).toHaveLength(1);
	});
});

describe("makeJobConsumer", () => {
	const envelope = (over: Record<string, unknown> = {}) => ({
		id: "env-1",
		kind: "test.ping",
		payload: { v: 1 },
		...over,
	});

	it("acks poison bodies without touching handlers or the projection", async () => {
		const { db } = makeTestDb();
		const handle = vi.fn<(payload: unknown, envelope: JobEnvelope) => Promise<void>>(
			async () => {},
		);
		const consumer = makeJobConsumer({
			handlers: { "test.ping": { handle } },
			db,
			newId: () => "gen",
			now: () => 1,
		});
		const log: string[] = [];
		await consumer([msg(null, log), msg("garbage", log), msg({ kind: 42 }, log)]);
		expect(log).toEqual(["ack", "ack", "ack"]);
		expect(handle).not.toHaveBeenCalled();
		expect(await listJobRuns(db)).toEqual([]);
	});

	it("dispatches by kind, marks processing→done and acks", async () => {
		const { db } = makeTestDb();
		const calls: { payload: unknown; envelope: JobEnvelope }[] = [];
		const registration: JobRegistration = {
			decodePayload: (p) => ({ decoded: p }),
			handle: async (payload, env) => {
				calls.push({ payload, envelope: env });
			},
		};
		const consumer = makeJobConsumer({
			handlers: { "test.ping": registration },
			db,
			now: () => 42,
		});
		const log: string[] = [];
		await consumer([msg(envelope({ tenantId: 5 }), log)]);
		expect(log).toEqual(["ack"]);
		expect(calls).toEqual([
			{
				payload: { decoded: { v: 1 } },
				envelope: { id: "env-1", kind: "test.ping", payload: { v: 1 }, tenantId: 5 },
			},
		]);
		expect(await getJobRun(db, "env-1")).toMatchObject({
			kind: "test.ping",
			status: "done",
			error: null,
			tenantId: 5,
			createdAt: 42,
			updatedAt: 42,
		});
	});

	it("marks the run processing while the handler runs", async () => {
		const { db } = makeTestDb();
		let seen: JobRecord | null = null;
		const consumer = makeJobConsumer({
			handlers: {
				"test.ping": {
					handle: async () => {
						seen = await getJobRun(db, "env-1");
					},
				},
			},
			db,
		});
		const log: string[] = [];
		await consumer([msg(envelope(), log)]);
		expect(log).toEqual(["ack"]);
		expect(seen).toMatchObject({ kind: "test.ping", status: "processing" });
	});

	it("passes the raw payload when no decodePayload is registered", async () => {
		const seen: unknown[] = [];
		const consumer = makeJobConsumer({
			handlers: {
				"test.ping": {
					handle: async (payload) => {
						seen.push(payload);
					},
				},
			},
		});
		const log: string[] = [];
		await consumer([msg(envelope(), log)]);
		expect(log).toEqual(["ack"]);
		expect(seen).toEqual([{ v: 1 }]);
	});

	it("acks + marks failed on invalid payloads and unknown kinds", async () => {
		const { db } = makeTestDb();
		const consumer = makeJobConsumer({
			handlers: {
				"test.ping": {
					decodePayload: (p) => {
						if (p !== "ok") throw new Error("bad payload");
						return p;
					},
					handle: async () => {},
				},
			},
			db,
			newId: () => "gen",
			now: () => 7,
		});
		const log: string[] = [];
		await consumer([
			msg(envelope({ id: "bad", payload: "nope" }), log),
			msg(envelope({ id: "unknown", kind: "no.such" }), log),
		]);
		expect(log).toEqual(["ack", "ack"]);
		expect(await getJobRun(db, "bad")).toMatchObject({
			status: "failed",
			error: "invalid job payload",
		});
		expect(await getJobRun(db, "unknown")).toMatchObject({
			status: "failed",
			error: "unknown job kind: no.such",
		});
	});

	it("marks failed and retries when the handler throws", async () => {
		const { db } = makeTestDb();
		const consumer = makeJobConsumer({
			handlers: {
				"test.ping": {
					handle: async () => {
						throw new Error("boom");
					},
				},
			},
			db,
		});
		const log: string[] = [];
		await consumer([msg(envelope(), log)]);
		expect(log).toEqual(["retry"]);
		expect(await getJobRun(db, "env-1")).toMatchObject({ status: "failed", error: "Error: boom" });
	});

	it("supports a custom normalizer for pre-envelope bodies", async () => {
		const { db } = makeTestDb();
		const seen: { id?: string; tenantId?: string | number | null }[] = [];
		const consumer = makeJobConsumer({
			handlers: {
				legacy: {
					handle: async (_p, env) => {
						seen.push({ id: env.id, tenantId: env.tenantId });
					},
				},
			},
			db,
			normalize: (body) =>
				typeof body === "object" && body !== null && "old" in body
					? { kind: "legacy", payload: body, tenantId: 9 }
					: null,
			newId: () => "gen-id",
			now: () => 3,
		});
		const log: string[] = [];
		await consumer([msg({ old: true }, log), msg({ nope: 1 }, log)]);
		expect(log).toEqual(["ack", "ack"]);
		expect(seen).toEqual([{ id: "gen-id", tenantId: 9 }]);
		expect(await getJobRun(db, "gen-id")).toMatchObject({ kind: "legacy", status: "done" });
	});

	it("generates ids and timestamps by default for id-less normalized jobs", async () => {
		const { db } = makeTestDb();
		const consumer = makeJobConsumer({
			handlers: { legacy: { handle: async () => {} } },
			db,
			normalize: () => ({ kind: "legacy", payload: {} }),
		});
		const log: string[] = [];
		await consumer([msg({}, log)]);
		expect(log).toEqual(["ack"]);
		const rows = await listJobRuns(db, { kind: "legacy" });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBeTruthy();
		expect(rows[0]!.status).toBe("done");
	});

	it("bounds same-kind concurrency and overlaps different kinds", async () => {
		const { db } = makeTestDb();
		const inflight = new Map<string, number>();
		const maxSeen = new Map<string, number>();
		const track = (kind: string) => async (): Promise<void> => {
			const cur = (inflight.get(kind) ?? 0) + 1;
			inflight.set(kind, cur);
			maxSeen.set(kind, Math.max(maxSeen.get(kind) ?? 0, cur));
			await new Promise((resolve) => setTimeout(resolve, 5));
			inflight.set(kind, cur - 1);
		};
		const consumer = makeJobConsumer({
			handlers: {
				"a.one": { handle: track("a.one"), concurrency: 2 },
				"b.two": { handle: track("b.two") },
				"c.three": { handle: track("c.three") },
			},
			db,
		});
		const log: string[] = [];
		await consumer([
			msg(envelope({ id: "a1", kind: "a.one" }), log),
			msg(envelope({ id: "a2", kind: "a.one" }), log),
			msg(envelope({ id: "a3", kind: "a.one" }), log),
			msg(envelope({ id: "b1", kind: "b.two" }), log),
			msg(envelope({ id: "c1", kind: "c.three" }), log),
			msg(envelope({ id: "c2", kind: "c.three" }), log),
		]);
		// a.one peaks at its declared limit of 2; default kinds stay serial.
		expect(maxSeen.get("a.one")).toBe(2);
		expect(maxSeen.get("b.two")).toBe(1);
		expect(maxSeen.get("c.three")).toBe(1);
		expect(log.filter((e) => e === "ack")).toHaveLength(6);
	});

	it("acks as exhausted once attempts reach the ceiling", async () => {
		const { db } = makeTestDb();
		const consumer = makeJobConsumer({
			handlers: {
				"test.ping": {
					handle: async () => {
						throw new Error("boom");
					},
				},
				"test.strict": {
					maxAttempts: 2,
					handle: async () => {
						throw new Error("boom");
					},
				},
			},
			db,
		});
		const log: string[] = [];
		const attempt = (id: string, kind: string, attempts: number): JobMessageLike => ({
			body: envelope({ id, kind }),
			attempts,
			ack: () => log.push("ack"),
			retry: () => log.push("retry"),
		});
		await consumer([
			attempt("early", "test.ping", 2), // below default ceiling (5) → retry
			attempt("last", "test.ping", 5), // at ceiling → ack exhausted
			attempt("strict", "test.strict", 2), // kind override → ack exhausted
		]);
		// Kinds overlap — assert the outcome multiset, not ordering.
		expect([...log].sort()).toEqual(["ack", "ack", "retry"]);
		expect(await getJobRun(db, "early")).toMatchObject({ status: "failed", error: "Error: boom" });
		expect(await getJobRun(db, "last")).toMatchObject({
			status: "failed",
			error: "attempts exhausted (5/5): Error: boom",
		});
		expect(await getJobRun(db, "strict")).toMatchObject({
			status: "failed",
			error: "attempts exhausted (2/2): Error: boom",
		});
	});

	it("honors a consumer-level maxAttempts override", async () => {
		const consumer = makeJobConsumer({
			handlers: {
				"test.ping": {
					handle: async () => {
						throw new Error("boom");
					},
				},
			},
			maxAttempts: 3,
		});
		const log: string[] = [];
		await consumer([
			{
				body: envelope(),
				attempts: 3,
				ack: () => log.push("ack"),
				retry: () => log.push("retry"),
			},
		]);
		expect(log).toEqual(["ack"]);
	});

	it("skips redelivery for idempotent kinds whose run is already done", async () => {
		const { db } = makeTestDb();
		await insertJobRun(db, { id: "env-done", kind: "test.ping", status: "done" });
		await insertJobRun(db, { id: "env-failed", kind: "test.ping", status: "failed" });
		const handle = vi.fn<(payload: unknown, envelope: JobEnvelope) => Promise<void>>(
			async () => {},
		);
		const consumer = makeJobConsumer({
			handlers: { "test.ping": { handle, idempotent: true } },
			db,
		});
		const log: string[] = [];
		await consumer([
			msg(envelope({ id: "env-done" }), log),
			msg(envelope({ id: "env-failed" }), log),
			msg(envelope({ id: "env-new" }), log),
		]);
		// The done row is acked untouched; failed and absent rows dispatch.
		expect(log).toEqual(["ack", "ack", "ack"]);
		expect(handle).toHaveBeenCalledTimes(2);
	});

	it("still dispatches idempotent kinds when the projection read fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const handle = vi.fn<(payload: unknown, envelope: JobEnvelope) => Promise<void>>(
			async () => {},
		);
		const consumer = makeJobConsumer({
			handlers: { "test.ping": { handle, idempotent: true } },
			db: {} as never,
		});
		const log: string[] = [];
		await consumer([msg(envelope(), log)]);
		expect(log).toEqual(["ack"]);
		expect(handle).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("runs without a db (no projection) and survives projection failures", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const consumer = makeJobConsumer({
			handlers: { "test.ping": { handle: async () => {} } },
		});
		const log: string[] = [];
		await consumer([msg(envelope(), log)]);
		expect(log).toEqual(["ack"]);
		expect(warn).not.toHaveBeenCalled();

		// A db whose writes always fail must not break delivery.
		const broken = makeJobConsumer({
			handlers: { "test.ping": { handle: async () => {} } },
			db: {} as never,
		});
		await broken([msg(envelope({ id: "x" }), log)]);
		expect(log).toEqual(["ack", "ack"]);
		expect(warn).toHaveBeenCalledWith(
			"job_runs projection write failed",
			expect.objectContaining({ id: "x" }),
		);
		warn.mockRestore();
	});
});

describe("dispatchJobInline", () => {
	it("kind-dispatches with decode, envelope and processing→done projection", async () => {
		const { db } = makeTestDb();
		const calls: { payload: unknown; envelope: JobEnvelope }[] = [];
		const seenDuring: JobRecord[] = [];
		await dispatchJobInline(
			{
				handlers: {
					"test.inline": {
						decodePayload: (p) => ({ decoded: p }),
						handle: async (payload, envelope) => {
							calls.push({ payload, envelope });
							const row = await getJobRun(db, "gen-id");
							if (row !== null) seenDuring.push(row);
						},
					},
				},
				db,
				newId: () => "gen-id",
				now: () => 42,
			},
			{ kind: "test.inline", payload: { v: 1 }, tenantId: 7 },
		);
		expect(calls).toEqual([
			{
				payload: { decoded: { v: 1 } },
				envelope: {
					id: "gen-id",
					kind: "test.inline",
					payload: { decoded: { v: 1 } },
					tenantId: 7,
				},
			},
		]);
		// The handler observed the in-flight "processing" mark.
		expect(seenDuring[0]).toMatchObject({ status: "processing", kind: "test.inline" });
		expect(await getJobRun(db, "gen-id")).toMatchObject({
			kind: "test.inline",
			status: "done",
			error: null,
			tenantId: 7,
			createdAt: 42,
			updatedAt: 42,
		});
	});

	it("honors a caller-supplied id", async () => {
		const { db } = makeTestDb();
		await dispatchJobInline(
			{ handlers: { "test.inline": { handle: async () => {} } }, db },
			{ kind: "test.inline", payload: null, id: "caller-id" },
		);
		expect(await getJobRun(db, "caller-id")).toMatchObject({ status: "done" });
	});

	it("throws on unknown kinds before any projection write", async () => {
		const { db } = makeTestDb();
		await expect(
			dispatchJobInline({ handlers: {}, db }, { kind: "test.missing", payload: null }),
		).rejects.toThrow("unknown job kind: test.missing");
		expect(await listJobRuns(db)).toEqual([]);
	});

	it("marks failed and rethrows on decode and handler failures", async () => {
		const { db } = makeTestDb();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				dispatchJobInline(
					{
						handlers: {
							"test.baddecode": {
								decodePayload: () => {
									throw new Error("bad payload");
								},
								handle: async () => {},
							},
							"test.boom": {
								handle: async () => {
									throw "string failure";
								},
							},
						},
						db,
						newId: (() => {
							let n = 0;
							return () => `id-${++n}`;
						})(),
					},
					{ kind: "test.baddecode", payload: {} },
				),
			).rejects.toThrow("bad payload");
			await expect(
				dispatchJobInline(
					{
						handlers: {
							"test.boom": {
								handle: async () => {
									throw "string failure";
								},
							},
						},
						db,
					},
					{ kind: "test.boom", payload: null, id: "boom-1" },
				),
			).rejects.toBe("string failure");
			expect(await getJobRun(db, "id-1")).toMatchObject({
				status: "failed",
				error: "bad payload",
			});
			expect(await getJobRun(db, "boom-1")).toMatchObject({
				status: "failed",
				error: "string failure",
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("swallows projection failures and still dispatches", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const handled: string[] = [];
		try {
			await dispatchJobInline(
				{
					handlers: {
						"test.inline": {
							handle: async () => {
								handled.push("ran");
							},
						},
					},
					db: {} as never,
				},
				{ kind: "test.inline", payload: null, id: "x" },
			);
			expect(handled).toEqual(["ran"]);
			expect(warn).toHaveBeenCalledWith(
				"job_runs projection write failed",
				expect.objectContaining({ id: "x" }),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("runs without a db bound", async () => {
		const seen: unknown[] = [];
		await dispatchJobInline(
			{
				handlers: {
					"test.inline": {
						handle: async (payload) => {
							seen.push(payload);
						},
					},
				},
			},
			{ kind: "test.inline", payload: { a: 1 } },
		);
		expect(seen).toEqual([{ a: 1 }]);
	});
});

describe("makeJobHandlerRegistry", () => {
	it("registers, replaces and looks up kind handlers per instance", () => {
		const registry = makeJobHandlerRegistry();
		const first: JobRegistration = { handle: async () => {} };
		const second: JobRegistration = { handle: async () => {} };
		const kind = "test.registry";
		registry.register(kind, first);
		expect(registry.lookup(kind)).toBe(first);
		expect(registry.has(kind)).toBe(true);
		registry.register(kind, second);
		expect(registry.lookup(kind)).toBe(second);
		expect(registry.kinds()).toEqual([kind]);
		expect(registry.handlers()[kind]).toBe(second);
	});

	it("keeps registries isolated — no shared module state", () => {
		const a = makeJobHandlerRegistry();
		const b = makeJobHandlerRegistry();
		a.register("test.only-a", { handle: async () => {} });
		expect(b.lookup("test.only-a")).toBeUndefined();
		expect(b.kinds()).toEqual([]);
	});

	it("handlers() snapshots the table at call time", () => {
		const registry = makeJobHandlerRegistry();
		registry.register("test.snap", { handle: async () => {} });
		const before = registry.handlers();
		registry.register("test.late", { handle: async () => {} });
		expect(before["test.late"]).toBeUndefined();
		expect(registry.handlers()["test.late"]).toBeDefined();
	});
});

describe("queueSend (Cloudflare delaySeconds adapter)", () => {
	it("sends immediately when the envelope has no runAt", async () => {
		const calls: { body: unknown; options?: { delaySeconds?: number } }[] = [];
		const send = queueSend({
			send: async (body, options) => {
				calls.push({ body, options });
			},
		});
		const envelope: JobEnvelope = { id: "j", kind: "k", payload: null };
		await send(envelope);
		expect(calls).toEqual([{ body: envelope, options: undefined }]);
	});

	it("maps a future runAt to rounded-up delaySeconds, clamped to the CF cap", async () => {
		const calls: { options?: { delaySeconds?: number } }[] = [];
		const send = queueSend({
			send: async (_body, options) => {
				calls.push({ options });
			},
		});
		const now = Date.now();
		await send({ id: "j", kind: "k", payload: null, runAt: now + 2_500 });
		const delay = calls[0]?.options?.delaySeconds ?? 0;
		expect(delay).toBeGreaterThanOrEqual(2);
		expect(delay).toBeLessThanOrEqual(4);
		// Far-future runAt clamps to the 12h Cloudflare cap.
		await send({ id: "j", kind: "k", payload: null, runAt: now + 100 * 24 * 3600 * 1000 });
		expect(calls[1]?.options?.delaySeconds).toBe(QUEUE_MAX_DELAY_SECONDS);
		// Past runAt delivers immediately (delaySeconds 0).
		await send({ id: "j", kind: "k", payload: null, runAt: now - 1000 });
		expect(calls[2]?.options?.delaySeconds).toBe(0);
	});
});
