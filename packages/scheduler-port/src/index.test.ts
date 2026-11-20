import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { makeDb, type DbClient } from "@ktb/db";
import { scheduledJobs } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";

import {
	claimDueScheduledJobs,
	deleteScheduledJob,
	deriveNextRunAt,
	getScheduledJob,
	insertScheduledJob,
	InvalidScheduleError,
	listScheduledJobs,
	nextRunAfter,
	runSchedulerSweep,
	updateScheduledJob,
	type ScheduledJob,
} from "./index.ts";

const DDL = `
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
`;

const makeTestDb = (): DbClient => makeDb(makeD1(DDL));

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // fixed instant for determinism

describe("nextRunAfter", () => {
	it("computes the next 5-field occurrence after `from`", () => {
		// "every 5 minutes" from 12:00:00 → 12:05:00
		expect(nextRunAfter("*/5 * * * *", T0)).toBe(T0 + 5 * 60_000);
	});

	it("rejects non-5-field and malformed expressions", () => {
		expect(() => nextRunAfter("* * * *", T0)).toThrow(InvalidScheduleError);
		expect(() => nextRunAfter("not a cron", T0)).toThrow(InvalidScheduleError);
	});

	it("returns null for expressions with no future occurrence", () => {
		// February 30th never happens — croner exhausts its search.
		expect(nextRunAfter("0 0 30 2 *", T0)).toBeNull();
	});

	it("wraps croner range failures in InvalidScheduleError", () => {
		// Five well-formed fields that croner itself rejects.
		expect(() => nextRunAfter("61 * * * *", T0)).toThrow(InvalidScheduleError);
	});
});

describe("deriveNextRunAt", () => {
	it("requires exactly one of cronExpr/runAt", () => {
		expect(() => deriveNextRunAt(null, null, T0)).toThrow(InvalidScheduleError);
		expect(() => deriveNextRunAt("* * * * *", T0, T0)).toThrow(InvalidScheduleError);
	});

	it("returns the runAt instant verbatim, past or future", () => {
		expect(deriveNextRunAt(null, T0 - 1000, T0)).toBe(T0 - 1000);
		expect(deriveNextRunAt(null, T0 + 1000, T0)).toBe(T0 + 1000);
	});

	it("rejects schedules that never fire and non-finite runAt", () => {
		expect(() => deriveNextRunAt("0 0 30 2 *", null, T0)).toThrow(InvalidScheduleError);
		expect(() => deriveNextRunAt(null, Number.NaN, T0)).toThrow(InvalidScheduleError);
	});
});

describe("insert/get/list", () => {
	it("inserts a recurring job with a derived nextRunAt", async () => {
		const db = makeTestDb();
		const job = await insertScheduledJob(
			db,
			{ kind: "agenda.reminders", cronExpr: "*/5 * * * *", params: { lead: 30 } },
			T0,
		);
		expect(job.nextRunAt).toBe(T0 + 5 * 60_000);
		expect(job.status).toBe("active");
		expect(job.params).toEqual({ lead: 30 });
		expect(await getScheduledJob(db, job.id)).toEqual(job);
	});

	it("inserts a one-off job and round-trips params", async () => {
		const db = makeTestDb();
		const job = await insertScheduledJob(db, { kind: "k", runAt: T0 + 60_000 }, T0);
		expect(job.nextRunAt).toBe(T0 + 60_000);
		expect(job.cronExpr).toBeNull();
	});

	it("treats an empty cronExpr as unset rather than storing it", async () => {
		const db = makeTestDb();
		const job = await insertScheduledJob(db, { kind: "k", runAt: T0 + 500, cronExpr: "" }, T0);
		expect(job.cronExpr).toBeNull();
		expect(job.nextRunAt).toBe(T0 + 500);
	});

	it("rejects empty kind and invalid schedules", async () => {
		const db = makeTestDb();
		await expect(insertScheduledJob(db, { kind: "  " }, T0)).rejects.toThrow(InvalidScheduleError);
		await expect(insertScheduledJob(db, { kind: "k", cronExpr: "bad expr" }, T0)).rejects.toThrow(
			InvalidScheduleError,
		);
	});

	it("lists with status/kind filters, ordered by nextRunAt", async () => {
		const db = makeTestDb();
		await insertScheduledJob(db, { kind: "a", runAt: T0 + 2000 }, T0);
		await insertScheduledJob(db, { kind: "b", runAt: T0 + 1000 }, T0);
		const paused = await insertScheduledJob(db, { kind: "a", runAt: T0 + 500 }, T0);
		await updateScheduledJob(db, paused.id, { status: "paused" }, T0);
		const all = await listScheduledJobs(db);
		expect(all.map((j) => j.kind)).toEqual(["a", "b", "a"]);
		expect((await listScheduledJobs(db, { status: "paused" })).map((j) => j.id)).toEqual([
			paused.id,
		]);
		expect((await listScheduledJobs(db, { kind: "b" })).length).toBe(1);
	});

	it("filters by tenant scope, including the null scope", async () => {
		const db = makeTestDb();
		const global = await insertScheduledJob(db, { kind: "g", runAt: T0 + 1000 }, T0);
		await insertScheduledJob(db, { kind: "t", runAt: T0 + 1000, tenantId: 7 }, T0);
		expect((await listScheduledJobs(db, { tenantId: null })).map((j) => j.id)).toEqual([global.id]);
		expect((await listScheduledJobs(db, { tenantId: 7 })).map((j) => j.kind)).toEqual(["t"]);
	});

	it("reads corrupt params JSON as null rather than throwing", async () => {
		const db = makeTestDb();
		await db.insert(scheduledJobs).values({
			id: "bad-params",
			kind: "k",
			params: "{not json",
			cronExpr: "0 * * * *",
			nextRunAt: T0,
			createdAt: T0,
			updatedAt: T0,
		});
		expect((await getScheduledJob(db, "bad-params"))?.params).toBeNull();
	});
});

describe("updateScheduledJob", () => {
	it("returns null for unknown ids", async () => {
		expect(await updateScheduledJob(makeTestDb(), "nope", { status: "paused" })).toBeNull();
	});

	it("recomputes nextRunAt when the schedule changes", async () => {
		const db = makeTestDb();
		const job = await insertScheduledJob(db, { kind: "k", runAt: T0 + 1000 }, T0);
		const moved = await updateScheduledJob(db, job.id, { runAt: T0 + 9000 }, T0);
		expect(moved?.nextRunAt).toBe(T0 + 9000);
		const recurring = await insertScheduledJob(db, { kind: "k2", cronExpr: "0 * * * *" }, T0);
		const rescheduled = await updateScheduledJob(db, recurring.id, { cronExpr: "30 * * * *" }, T0);
		expect(rescheduled?.cronExpr).toBe("30 * * * *");
		expect(rescheduled?.nextRunAt).toBeGreaterThan(T0);
	});

	it("pause keeps nextRunAt; resume re-derives it", async () => {
		const db = makeTestDb();
		const job = await insertScheduledJob(db, { kind: "k", runAt: T0 + 500 }, T0);
		const paused = await updateScheduledJob(db, job.id, { status: "paused" }, T0);
		expect(paused?.nextRunAt).toBe(T0 + 500);
		// Resume far in the future of the runAt — a stale past timestamp
		// must not burst-fire.
		const resumed = await updateScheduledJob(db, job.id, { status: "active" }, T0 + 10_000);
		expect(resumed?.status).toBe("active");
		expect(resumed?.nextRunAt).toBe(T0 + 500);
	});

	it("accepts explicit null schedule fields and params-only patches", async () => {
		const db = makeTestDb();
		const oneOff = await insertScheduledJob(db, { kind: "k", runAt: T0 + 500 }, T0);
		// Clearing cronExpr on a one-off row is a no-op schedule-wise.
		const cleared = await updateScheduledJob(db, oneOff.id, { cronExpr: null }, T0);
		expect(cleared?.cronExpr).toBeNull();
		expect(cleared?.nextRunAt).toBe(T0 + 500);
		// "" normalizes to null too — a stored empty string would read
		// as recurring at claim time.
		const clearedEmpty = await updateScheduledJob(db, oneOff.id, { cronExpr: "" }, T0);
		expect(clearedEmpty?.cronExpr).toBeNull();
		const recurring = await insertScheduledJob(db, { kind: "k2", cronExpr: "0 * * * *" }, T0);
		const kept = await updateScheduledJob(db, recurring.id, { runAt: null, params: { a: 1 } }, T0);
		expect(kept?.cronExpr).toBe("0 * * * *");
		expect(kept?.params).toEqual({ a: 1 });
	});
});

describe("deleteScheduledJob", () => {
	it("removes the row and reports whether it existed", async () => {
		const db = makeTestDb();
		const job = await insertScheduledJob(db, { kind: "k", runAt: T0 }, T0);
		expect(await deleteScheduledJob(db, job.id)).toBe(true);
		expect(await deleteScheduledJob(db, job.id)).toBe(false);
		expect(await getScheduledJob(db, job.id)).toBeNull();
	});
});

describe("claimDueScheduledJobs", () => {
	it("claims only due, unclaimed, active rows", async () => {
		const db = makeTestDb();
		const due = await insertScheduledJob(db, { kind: "due", runAt: T0 - 1 }, T0);
		await insertScheduledJob(db, { kind: "future", runAt: T0 + 60_000 }, T0);
		const paused = await insertScheduledJob(db, { kind: "p", runAt: T0 - 1 }, T0);
		await updateScheduledJob(db, paused.id, { status: "paused" }, T0);
		const claimed = await claimDueScheduledJobs(db, { now: T0 });
		expect(claimed.map((j) => j.id)).toEqual([due.id]);
	});

	it("advances recurring nextRunAt and marks one-offs done", async () => {
		const db = makeTestDb();
		const recurring = await insertScheduledJob(
			db,
			{ kind: "r", cronExpr: "*/5 * * * *" },
			T0 - 10 * 60_000,
		);
		// Force it due: rewrite nextRunAt into the past.
		await db
			.update(scheduledJobs)
			.set({ nextRunAt: T0 - 60_000 })
			.where(eq(scheduledJobs.id, recurring.id));
		const oneOff = await insertScheduledJob(db, { kind: "o", runAt: T0 - 1 }, T0);
		const claimed = await claimDueScheduledJobs(db, { now: T0 });
		expect(claimed).toHaveLength(2);
		const r = await getScheduledJob(db, recurring.id);
		expect(r?.status).toBe("active");
		// Coalesced: next occurrence after now, not the missed one.
		expect(r?.nextRunAt).toBe(T0 + 5 * 60_000);
		expect(r?.lastRunAt).toBe(T0);
		expect(r?.claimedUntil).toBe(T0 + 5 * 60_000);
		const o = await getScheduledJob(db, oneOff.id);
		expect(o?.status).toBe("done");
	});

	it("does not re-claim rows inside their lease window", async () => {
		const db = makeTestDb();
		await insertScheduledJob(db, { kind: "k", runAt: T0 - 1 }, T0);
		await claimDueScheduledJobs(db, { now: T0, leaseMs: 60_000 });
		// One-off flipped to done — but simulate a recurring row stuck
		// claimed: insert another due row and claim with a fresh lease.
		const recurring = await insertScheduledJob(db, { kind: "r2", cronExpr: "* * * * *" }, T0);
		await db
			.update(scheduledJobs)
			.set({ nextRunAt: T0 - 1 })
			.where(eq(scheduledJobs.id, recurring.id));
		await claimDueScheduledJobs(db, { now: T0, leaseMs: 60_000 });
		const again = await claimDueScheduledJobs(db, { now: T0 + 30_000 });
		expect(again).toHaveLength(0);
		// After the lease expires the row is claimable again — but its
		// nextRunAt was already advanced past `now`, so it stays put.
		const later = await claimDueScheduledJobs(db, { now: T0 + 120_000 });
		expect(later.map((j) => j.id)).toEqual([recurring.id]);
	});

	it("treats a stored empty cronExpr as a one-off at claim time", async () => {
		const db = makeTestDb();
		// Bypass write validation to simulate a legacy/poisoned row.
		await db.insert(scheduledJobs).values({
			id: "empty-cron",
			kind: "k",
			cronExpr: "",
			runAt: T0 - 1,
			nextRunAt: T0 - 1,
			createdAt: T0,
			updatedAt: T0,
		});
		const claimed = await claimDueScheduledJobs(db, { now: T0 });
		expect(claimed.map((j) => j.id)).toEqual(["empty-cron"]);
		expect((await getScheduledJob(db, "empty-cron"))?.status).toBe("done");
	});

	it("retires recurring rows whose cron expression can never fire again", async () => {
		const db = makeTestDb();
		// Bypass insert validation to simulate a stored expression that
		// croner rejects outright.
		await db.insert(scheduledJobs).values({
			id: "exhausted",
			kind: "k",
			cronExpr: "61 * * * *",
			nextRunAt: T0 - 1,
			createdAt: T0,
			updatedAt: T0,
		});
		expect(await claimDueScheduledJobs(db, { now: T0 })).toEqual([]);
		expect((await getScheduledJob(db, "exhausted"))?.status).toBe("done");
	});

	it("skips a candidate another writer changed between select and update", async () => {
		const inner = makeD1(DDL);
		let tripped = false;
		const db = makeDb({
			...inner,
			prepare: (q: string) => {
				// The claim UPDATE is the only write setting last_run_at —
				// pause the row as it is prepared to simulate a concurrent
				// writer winning the race; the conditional UPDATE then
				// matches zero rows.
				if (!tripped && q.includes('update "scheduled_jobs" set') && q.includes('"last_run_at"')) {
					tripped = true;
					void inner.prepare("update scheduled_jobs set status = 'paused'").run();
				}
				return inner.prepare(q);
			},
		});
		await insertScheduledJob(db, { kind: "k", runAt: T0 - 1 }, T0);
		expect(await claimDueScheduledJobs(db, { now: T0 })).toEqual([]);
	});

	it("defaults now/lease/limit when options are omitted", async () => {
		const db = makeTestDb();
		await insertScheduledJob(db, { kind: "k", runAt: Date.now() - 1000 }, Date.now());
		const claimed = await claimDueScheduledJobs(db);
		expect(claimed).toHaveLength(1);
		const result = await runSchedulerSweep(db, async () => {});
		expect(result.claimed).toBe(0);
	});
});

describe("runSchedulerSweep", () => {
	it("dispatches claimed rows and counts failures without throwing", async () => {
		const db = makeTestDb();
		const a = await insertScheduledJob(db, { kind: "ok", runAt: T0 - 2 }, T0);
		const b = await insertScheduledJob(db, { kind: "bad", runAt: T0 - 1 }, T0);
		const seen: ScheduledJob[] = [];
		const result = await runSchedulerSweep(
			db,
			async (job) => {
				seen.push(job);
				if (job.id === b.id) throw new Error("boom");
			},
			{ now: T0 },
		);
		expect(result).toEqual({ claimed: 2, fired: 1, failed: 1 });
		expect(seen.map((j) => j.id).sort()).toEqual([a.id, b.id].sort());
	});

	it("releases claims so sub-lease recurring schedules keep firing", async () => {
		const db = makeTestDb();
		const job = await insertScheduledJob(db, { kind: "k", cronExpr: "* * * * *" }, T0);
		// First occurrence at T0+60s; the default 5min lease would still
		// be live at the next occurrence if the sweep didn't release it.
		const first = await runSchedulerSweep(db, async () => {}, { now: T0 + 60_000 });
		expect(first).toEqual({ claimed: 1, fired: 1, failed: 0 });
		expect((await getScheduledJob(db, job.id))?.claimedUntil).toBeNull();
		const second = await claimDueScheduledJobs(db, { now: T0 + 120_000 });
		expect(second.map((j) => j.id)).toEqual([job.id]);
	});

	it("logs and continues when a claim release fails", async () => {
		// The release UPDATE is the only scheduled_jobs write whose SET
		// clause is claimed_until alone — fail just that statement.
		const inner = makeD1(DDL);
		const db = makeDb({
			...inner,
			prepare: (q: string) => {
				if (/set "claimed_until" = \? where/.test(q)) throw new Error("release boom");
				return inner.prepare(q);
			},
		});
		await insertScheduledJob(db, { kind: "k", runAt: T0 - 1 }, T0);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await runSchedulerSweep(db, async () => {}, { now: T0 });
			expect(result).toEqual({ claimed: 1, fired: 1, failed: 0 });
			expect(warn).toHaveBeenCalledWith(
				"scheduled job claim release failed",
				expect.objectContaining({ error: expect.stringContaining("release boom") }),
			);
		} finally {
			warn.mockRestore();
		}
	});
});
