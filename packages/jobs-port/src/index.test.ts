import { describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import {
	decodeJobEnvelope,
	getJobRun,
	insertJobRun,
	JobEnvelopeSchema,
	JobRecordSchema,
	Jobs,
	JobsLive,
	listJobRuns,
	makeJobConsumer,
	makeJobs,
	jobHandlers,
	registerJobHandler,
	upsertJobRun,
	type JobEnvelope,
	type JobMessageLike,
	type JobRegistration,
} from "./index.ts";

const DDL = `
CREATE TABLE job_runs (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'queued',
	payload_ref TEXT,
	error TEXT,
	tenant_id INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
`;

const makeTestDb = () => {
	const sql = makeD1(DDL);
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
		expect(decodeJobEnvelope({ id: "j", kind: "k", tenantId: "x" })).toBeNull();
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

		const all = await listJobRuns(db);
		expect(all.map((r) => r.id)).toEqual(["c", "b", "a"]); // newest first

		expect((await listJobRuns(db, { kind: "k1" })).map((r) => r.id)).toEqual(["c", "a"]);
		expect((await listJobRuns(db, { status: "failed" })).map((r) => r.id)).toEqual(["b"]);
		expect((await listJobRuns(db, { tenantId: null })).map((r) => r.id)).toEqual(["c", "a"]);
		expect((await listJobRuns(db, { tenantId: 7 })).map((r) => r.id)).toEqual(["b"]);
		expect(
			(await listJobRuns(db, { kind: "k1", status: "queued", tenantId: null, limit: 1 })).map(
				(r) => r.id,
			),
		).toEqual(["c"]);
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
		const seen: { id?: string; tenantId?: number | null }[] = [];
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

	it("runs without a db (no projection) and survives projection failures", async () => {
		const consumer = makeJobConsumer({
			handlers: { "test.ping": { handle: async () => {} } },
		});
		const log: string[] = [];
		await consumer([msg(envelope(), log)]);
		expect(log).toEqual(["ack"]);

		// A db whose writes always fail must not break delivery.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const broken = makeJobConsumer({
			handlers: { "test.ping": { handle: async () => {} } },
			db: {} as never,
		});
		await broken([msg(envelope({ id: "x" }), log)]);
		expect(log).toEqual(["ack", "ack"]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("jobHandlers registry", () => {
	it("registers and replaces kind handlers", () => {
		const first: JobRegistration = { handle: async () => {} };
		const second: JobRegistration = { handle: async () => {} };
		const kind = "test.registry";
		try {
			registerJobHandler(kind, first);
			expect(jobHandlers[kind]).toBe(first);
			registerJobHandler(kind, second);
			expect(jobHandlers[kind]).toBe(second);
		} finally {
			delete jobHandlers[kind];
		}
		expect(jobHandlers[kind]).toBeUndefined();
	});
});
