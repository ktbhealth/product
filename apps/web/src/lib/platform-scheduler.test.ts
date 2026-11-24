import { describe, expect, it, vi } from "vitest";

import { listJobRuns } from "@ktb/jobs-port";
import { insertScheduledJob } from "@ktb/scheduler-port";

// Scheduler dispatch (P-094): the scheduler-heartbeat cron runner claims
// due scheduled_jobs rows and dispatches each through dispatchScheduledJob.
// With AUDIO_QUEUE bound the job becomes a queue envelope; without it the
// inline fallback kind-dispatches through jobHandlers with the same
// job_runs projection writes. env ships AUDIO_QUEUE bound by default, so
// the inline path tests unbind it before composing.

const hoisted = vi.hoisted(() => ({
	upsertFails: false,
	handled: [] as { kind: string; payload: unknown; tenantId: number | null }[],
}));

vi.mock("@ktb/jobs-port", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/jobs-port")>();
	return {
		...actual,
		upsertJobRun: async (...args: Parameters<typeof actual.upsertJobRun>) => {
			if (hoisted.upsertFails) throw new Error("job_runs write down");
			return actual.upsertJobRun(...args);
		},
	};
});

const compose = async (configure: (env: Record<string, unknown>) => void = () => {}) => {
	vi.resetModules();
	const { env } = await import("#/test/cloudflare-workers.ts");
	configure(env as Record<string, unknown>);
	const platform = await import("./platform.ts");
	const { getServerRuntime } = await import("@ktb/server-fns");
	// registerJobHandler must come from the same post-reset module
	// instance platform.ts composed against.
	const { registerJobHandler } = await import("@ktb/jobs-port");
	return { runtime: getServerRuntime(), platform, registerJobHandler };
};

const dueJob = (
	platform: { db: Parameters<typeof insertScheduledJob>[0] },
	kind: string,
	params?: unknown,
) => insertScheduledJob(platform.db, { kind, runAt: Date.now() - 1000, params, tenantId: 7 });

describe("platform scheduler-heartbeat dispatch", () => {
	it("enqueues due jobs through the bound queue", { timeout: 30_000 }, async () => {
		const sent: { kind: string; payload: unknown; tenantId?: number | null }[] = [];
		const { runtime, platform } = await compose((env) => {
			env.AUDIO_QUEUE = {
				send: async (body: unknown) => {
					sent.push(body as (typeof sent)[number]);
				},
			};
		});
		await dueJob(platform, "test.sched.enqueued");

		expect(await runtime.crons!.runNow("scheduler-heartbeat")).toMatchObject({
			ok: true,
			summary: "1 scheduled job fired",
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ kind: "test.sched.enqueued", tenantId: 7 });
	});

	it(
		"inline-dispatches due jobs, decodes payloads and marks job_runs done",
		{ timeout: 30_000 },
		async () => {
			hoisted.handled = [];
			const { runtime, platform, registerJobHandler } = await compose((env) => {
				env.AUDIO_QUEUE = undefined;
			});
			registerJobHandler("test.sched.ok", {
				decodePayload: (payload) => ({ wrapped: payload }),
				handle: async (payload, envelope) => {
					hoisted.handled.push({
						kind: envelope.kind,
						payload,
						tenantId: envelope.tenantId ?? null,
					});
				},
			});
			await dueJob(platform, "test.sched.ok", { v: 1 });

			expect(await runtime.crons!.runNow("scheduler-heartbeat")).toMatchObject({
				ok: true,
				summary: "1 scheduled job fired",
			});
			expect(hoisted.handled).toEqual([
				{ kind: "test.sched.ok", payload: { wrapped: { v: 1 } }, tenantId: 7 },
			]);
			const runs = await listJobRuns(platform.db, { kind: "test.sched.ok" });
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({ status: "done", tenantId: 7 });
		},
	);

	it(
		"marks job_runs failed and counts the dispatch as failed when the handler throws",
		{ timeout: 30_000 },
		async () => {
			const { runtime, platform, registerJobHandler } = await compose((env) => {
				env.AUDIO_QUEUE = undefined;
			});
			registerJobHandler("test.sched.boom", {
				handle: async () => {
					throw new Error("handler down");
				},
			});
			await dueJob(platform, "test.sched.boom");

			expect(await runtime.crons!.runNow("scheduler-heartbeat")).toMatchObject({
				ok: false,
				error: "1 dispatch(es) failed",
			});
			const runs = await listJobRuns(platform.db, { kind: "test.sched.boom" });
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({ status: "failed", error: "handler down" });
		},
	);

	it("stringifies non-Error handler failures into job_runs", { timeout: 30_000 }, async () => {
		const { runtime, platform, registerJobHandler } = await compose((env) => {
			env.AUDIO_QUEUE = undefined;
		});
		registerJobHandler("test.sched.stringboom", {
			handle: async () => {
				throw "string failure";
			},
		});
		await dueJob(platform, "test.sched.stringboom");

		expect(await runtime.crons!.runNow("scheduler-heartbeat")).toMatchObject({
			ok: false,
			error: "1 dispatch(es) failed",
		});
		const runs = await listJobRuns(platform.db, { kind: "test.sched.stringboom" });
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ status: "failed", error: "string failure" });
	});

	it("fails dispatches for kinds with no registered handler", { timeout: 30_000 }, async () => {
		const { runtime, platform } = await compose((env) => {
			env.AUDIO_QUEUE = undefined;
		});
		await dueJob(platform, "test.sched.unregistered");

		expect(await runtime.crons!.runNow("scheduler-heartbeat")).toMatchObject({
			ok: false,
			error: "1 dispatch(es) failed",
		});
	});

	it("still dispatches when the job_runs projection write fails", { timeout: 30_000 }, async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		hoisted.upsertFails = true;
		try {
			const { runtime, platform, registerJobHandler } = await compose((env) => {
				env.AUDIO_QUEUE = undefined;
			});
			registerJobHandler("test.sched.projfail", { handle: async () => {} });
			await dueJob(platform, "test.sched.projfail");

			expect(await runtime.crons!.runNow("scheduler-heartbeat")).toMatchObject({
				ok: true,
				summary: "1 scheduled job fired",
			});
			expect(errorSpy).toHaveBeenCalledWith(
				"scheduler projection write failed",
				expect.objectContaining({ kind: "test.sched.projfail" }),
			);
		} finally {
			hoisted.upsertFails = false;
			errorSpy.mockRestore();
		}
	});
});

describe("platform capability views", () => {
	it("exposes job-kind, schedulable and topic declarations", { timeout: 90_000 }, async () => {
		const { runtime, registerJobHandler } = await compose();
		registerJobHandler("test.cap.view", { handle: async () => {} });

		const kinds = runtime.jobKindInfo!();
		expect(kinds.map((info) => info.kind)).toContain("test.cap.view");
		expect(kinds.find((info) => info.kind === "jobs.ping")).toMatchObject({
			schedulable: true,
		});

		expect(runtime.schedulableKinds!().map((info) => info.id)).toContain("jobs.ping.smoke");
		expect(runtime.pubsub?.declaredTopics?.().map((info) => info.topic)).toContain("cron.fires");
	});
});

describe("platform schedules capability", () => {
	it("lists, creates, updates, removes and runs scheduled jobs", { timeout: 30_000 }, async () => {
		const { runtime, platform, registerJobHandler } = await compose((env) => {
			env.AUDIO_QUEUE = undefined;
		});
		const schedules = runtime.schedules!;
		registerJobHandler("test.sched.cap", { handle: async () => {} });

		expect(runtime.jobKinds!()).toContain("test.sched.cap");
		expect(await schedules.list()).toEqual([]);

		const created = await schedules.create({
			kind: "test.sched.cap",
			cronExpr: "*/10 * * * *",
			params: { v: 1 },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error("create failed");
		expect(created.job).toMatchObject({
			kind: "test.sched.cap",
			cronExpr: "*/10 * * * *",
			status: "active",
		});
		expect(await schedules.list()).toHaveLength(1);

		const badCreate = await schedules.create({ kind: "test.sched.cap", cronExpr: "bad expr" });
		expect(badCreate).toMatchObject({ ok: false, reason: "invalid" });

		// Undispatchable kinds are rejected before any row is written.
		const unknownKind = await schedules.create({ kind: "test.sched.unknown", runAt: 1 });
		expect(unknownKind).toMatchObject({ ok: false, reason: "invalid" });

		// jobs.ping.smoke declares paramsSchema {type:"object"} — a scalar
		// payload fails the declared-schema gate.
		const badParams = await schedules.create({
			kind: "jobs.ping",
			runAt: 1,
			params: "not-an-object",
		});
		expect(badParams).toMatchObject({ ok: false, reason: "invalid" });

		// params that JSON.stringify rejects surface as unavailable, not invalid.
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const brokenCreate = await schedules.create({
			kind: "test.sched.cap",
			runAt: 1,
			params: circular,
		});
		expect(brokenCreate).toMatchObject({ ok: false, reason: "unavailable" });

		const id = created.ok ? created.job.id : "";
		const updated = await schedules.update(id, { status: "paused" });
		expect(updated).toMatchObject({ ok: true });
		if (!updated.ok) throw new Error("update failed");
		expect(updated.job.status).toBe("paused");

		expect(await schedules.update("missing-id", { status: "paused" })).toEqual({
			ok: false,
			reason: "not-found",
		});
		const badUpdate = await schedules.update(id, { cronExpr: "bad expr" });
		expect(badUpdate).toMatchObject({ ok: false, reason: "invalid" });
		const brokenUpdate = await schedules.update(id, { params: circular });
		expect(brokenUpdate).toMatchObject({ ok: false, reason: "unavailable" });

		// runNow: missing row → null; paused row → null; active due row fires.
		expect(await schedules.runNow("missing-id")).toBeNull();
		expect(await schedules.runNow(id)).toBeNull(); // paused
		await schedules.update(id, { status: "active", runAt: Date.now() - 1000, cronExpr: null });
		const fired = await schedules.runNow(id);
		expect(fired).toMatchObject({ id, ok: true });

		// Dispatch failure surfaces as ok:false with the error string. Create
		// rejects unknown kinds up front, so seed the row directly to reach
		// the fire-time failure path.
		const ghost = await insertScheduledJob(platform.db, {
			kind: "test.sched.ghost",
			runAt: Date.now() - 1000,
		});
		const failed = await schedules.runNow(ghost.id);
		expect(failed).toMatchObject({ id: ghost.id, ok: false });
		expect(failed?.error).toContain("unknown job kind");

		expect(await schedules.remove(id)).toEqual({ ok: true });
		expect(await schedules.remove(id)).toEqual({ ok: false, reason: "not-found" });
	});
});
