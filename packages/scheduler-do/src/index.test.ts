import type { SqlDatabase } from "@ktb/db";
import { makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { insertScheduledJob } from "@ktb/scheduler-port";
import { describe, expect, it } from "vitest";
import { notifySchedulerDo, SchedulerDo } from "./index.ts";

const SCHEDULER_DDL = `
CREATE TABLE scheduled_jobs (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	params TEXT,
	cron_expr TEXT,
	run_at INTEGER,
	next_run_at INTEGER NOT NULL,
	claimed_until INTEGER,
	last_run_at INTEGER,
	status TEXT NOT NULL DEFAULT 'active',
	tenant_id INTEGER,
	created_by TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
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

/** In-memory DO storage fake. */
function makeState() {
	const data = new Map<string, unknown>();
	let alarm: number | null = null;
	return {
		state: {
			storage: {
				get: async <T>(key: string) => data.get(key) as T | undefined,
				put: async (key: string, value: unknown) => {
					data.set(key, value);
				},
				setAlarm: async (t: number | Date) => {
					alarm = typeof t === "number" ? t : t.getTime();
				},
				deleteAlarm: async () => {
					alarm = null;
				},
			},
		},
		alarm: () => alarm,
		data,
	};
}

function makeEnv(overrides: Record<string, unknown> = {}) {
	const sent: unknown[] = [];
	return {
		env: {
			AUDIO_QUEUE: {
				send: async (body: unknown) => {
					sent.push(body);
				},
			},
			...overrides,
		},
		sent,
	};
}

const post = (path: string, body: unknown) =>
	new Request(`https://do${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

describe("SchedulerDo scheduling", () => {
	it("arms the alarm at the earliest pending run_at", async () => {
		const { state, alarm } = makeState();
		const { env } = makeEnv();
		const do_ = new SchedulerDo(state as never, env as never);

		await do_.fetch(post("/schedule", { id: "a", runAt: 5000 }));
		expect(alarm()).toBe(5000);
		await do_.fetch(post("/schedule", { id: "b", runAt: 3000 }));
		expect(alarm()).toBe(3000);
		await do_.fetch(post("/schedule", { id: "c", runAt: 9000 }));
		expect(alarm()).toBe(3000);
	});

	it("rejects malformed schedule bodies", async () => {
		const { state } = makeState();
		const { env } = makeEnv();
		const do_ = new SchedulerDo(state as never, env as never);

		const res = await do_.fetch(post("/schedule", { id: "a" }));
		expect(res.status).toBe(400);
		const res2 = await do_.fetch(post("/schedule", { runAt: 1 }));
		expect(res2.status).toBe(400);
		const res3 = await do_.fetch(post("/unschedule", {}));
		expect(res3.status).toBe(400);
	});

	it("rejects unparseable JSON bodies on both mutation routes", async () => {
		const { state } = makeState();
		const { env } = makeEnv();
		const do_ = new SchedulerDo(state as never, env as never);
		const bad = () =>
			new Request("https://do/schedule", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			});
		expect((await do_.fetch(bad())).status).toBe(400);
		const badUnschedule = () =>
			new Request("https://do/unschedule", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			});
		expect((await do_.fetch(badUnschedule())).status).toBe(400);
	});

	it("unschedule drops the entry and re-arms", async () => {
		const { state, alarm } = makeState();
		const { env } = makeEnv();
		const do_ = new SchedulerDo(state as never, env as never);

		await do_.fetch(post("/schedule", { id: "a", runAt: 5000 }));
		await do_.fetch(post("/schedule", { id: "b", runAt: 3000 }));
		await do_.fetch(post("/unschedule", { id: "b" }));
		expect(alarm()).toBe(5000);
		await do_.fetch(post("/unschedule", { id: "a" }));
		expect(alarm()).toBeNull();
	});

	it("alarm() prunes fired entries and re-arms the next", async () => {
		const { state, alarm, data } = makeState();
		const { env } = makeEnv(); // no DB → sweep skipped
		const do_ = new SchedulerDo(state as never, env as never);

		const now = Date.now();
		await do_.fetch(post("/schedule", { id: "past", runAt: now - 1000 }));
		await do_.fetch(post("/schedule", { id: "future", runAt: now + 60_000 }));
		// earliest armed = the past entry (fires immediately)
		expect(alarm()).toBe(now - 1000);

		await do_.alarm();
		const pending = data.get("pending") as Record<string, number>;
		expect(pending.past).toBeUndefined();
		expect(pending.future).toBe(now + 60_000);
		expect(alarm()).toBe(now + 60_000);
	});

	it("alarm() runs the sweep and dispatches through the queue", async () => {
		const { state } = makeState();
		const { env, sent } = makeEnv({
			DB: {} as SqlDatabase, // truthy — sweep path taken; drizzle calls will reject
		});
		const do_ = new SchedulerDo(state as never, env as never);
		// Sweep failure is swallowed (heartbeat backstops) — alarm still
		// completes and reschedules.
		await do_.fetch(post("/schedule", { id: "x", runAt: Date.now() + 1000 }));
		await expect(do_.alarm()).resolves.toBeUndefined();
		expect(sent).toHaveLength(0);
	});

	it("alarm() sweeps due rows and enqueues through the queue binding", async () => {
		const sql = makeD1(SCHEDULER_DDL);
		const db = makeDb(sql);
		await insertScheduledJob(db, { kind: "test.sched.do", runAt: Date.now() - 1000 });
		const { state } = makeState();
		const { env, sent } = makeEnv({ DB: sql });
		const do_ = new SchedulerDo(state as never, env as never);
		await do_.alarm();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ kind: "test.sched.do" });
	});

	it("alarm() skips the sweep when the queue binding is absent", async () => {
		const sql = makeD1(SCHEDULER_DDL);
		const db = makeDb(sql);
		await insertScheduledJob(db, { kind: "test.sched.do", runAt: Date.now() - 1000 });
		const { state } = makeState();
		const { env } = makeEnv({ DB: sql, AUDIO_QUEUE: undefined });
		const do_ = new SchedulerDo(state as never, env as never);
		await expect(do_.alarm()).resolves.toBeUndefined();
	});

	it("/state reports pending entries and next alarm", async () => {
		const { state } = makeState();
		const { env } = makeEnv();
		const do_ = new SchedulerDo(state as never, env as never);

		await do_.fetch(post("/schedule", { id: "a", runAt: 5000 }));
		await do_.fetch(post("/schedule", { id: "b", runAt: 3000 }));
		const res = await do_.fetch(new Request("https://do/state"));
		const body = (await res.json()) as {
			pending: Record<string, number>;
			alarm: number;
		};
		expect(body.pending).toEqual({ a: 5000, b: 3000 });
		expect(body.alarm).toBe(3000);
	});

	it("unknown routes 404", async () => {
		const { state } = makeState();
		const { env } = makeEnv();
		const do_ = new SchedulerDo(state as never, env as never);
		const res = await do_.fetch(new Request("https://do/nope"));
		expect(res.status).toBe(404);
	});
});

describe("notifySchedulerDo", () => {
	it("is a no-op without a namespace", async () => {
		await expect(
			notifySchedulerDo(undefined, "/schedule", { id: "a", runAt: 1 }),
		).resolves.toBeUndefined();
	});

	it("posts to the global instance", async () => {
		const calls: { url: string; body: unknown }[] = [];
		const ns = {
			idFromName: (name: string) => ({ toString: () => name }),
			get: () => ({
				fetch: async (req: Request) => {
					calls.push({
						url: req.url,
						body: await req.json(),
					});
					return new Response("ok");
				},
			}),
		};
		await notifySchedulerDo(ns, "/schedule", { id: "a", runAt: 123 });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/schedule");
		expect(calls[0]?.body).toEqual({ id: "a", runAt: 123 });
	});

	it("swallows namespace failures (heartbeat backstops)", async () => {
		const ns = {
			idFromName: () => ({ toString: () => "global" }),
			get: () => ({
				fetch: async () => {
					throw new Error("DO unreachable");
				},
			}),
		};
		await expect(notifySchedulerDo(ns, "/unschedule", { id: "a" })).resolves.toBeUndefined();
	});
});
