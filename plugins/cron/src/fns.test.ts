import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	serverFnRequestHeaders,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden } from "@ktb/authz";
import type { ScheduleDeleteResult, ScheduleWriteResult } from "@ktb/server-fns";

import { CronAdmin, type CronRunNowResult } from "./admin.ts";
import {
	createScheduleFn,
	deleteScheduleFn,
	runCronJobFn,
	runScheduleFn,
	updateScheduleFn,
} from "./fns.ts";

let currentEmail: string | null = "admin@x.com";
let runNowResult: CronRunNowResult = { ok: true };
let runNowForbidden = false;
const runNowCalls: string[] = [];
const scheduleCalls: unknown[][] = [];
let scheduleForbidden = false;

const adminStub = CronAdmin.of({
	jobs: () => Effect.succeed(null),
	runs: () => Effect.succeed([]),
	runNow: (id) => {
		runNowCalls.push(id);
		return runNowForbidden
			? Effect.fail(new Forbidden({ path: "platform.admin" }))
			: Effect.succeed(runNowResult);
	},
	schedules: () => Effect.succeed([]),
	entries: () => Effect.succeed(null),
	scheduleKinds: () => Effect.succeed([]),
	schedulableKinds: () => Effect.succeed([]),
	createSchedule: (input): Effect.Effect<ScheduleWriteResult, Forbidden> => {
		scheduleCalls.push(["create", input]);
		return scheduleForbidden
			? Effect.fail(new Forbidden({ path: "platform.admin" }))
			: Effect.succeed({
					ok: true as const,
					job: { id: "sched-1" },
				} as ScheduleWriteResult);
	},
	updateSchedule: (id, patch): Effect.Effect<ScheduleWriteResult, Forbidden> => {
		scheduleCalls.push(["update", id, patch]);
		return scheduleForbidden
			? Effect.fail(new Forbidden({ path: "platform.admin" }))
			: Effect.succeed({ ok: true as const, job: { id } } as ScheduleWriteResult);
	},
	deleteSchedule: (id): Effect.Effect<ScheduleDeleteResult, Forbidden> => {
		scheduleCalls.push(["delete", id]);
		return scheduleForbidden
			? Effect.fail(new Forbidden({ path: "platform.admin" }))
			: Effect.succeed({ ok: true as const });
	},
	runScheduleNow: (id): Effect.Effect<CronRunNowResult, Forbidden> => {
		scheduleCalls.push(["run", id]);
		return scheduleForbidden
			? Effect.fail(new Forbidden({ path: "platform.admin" }))
			: Effect.succeed({ ok: true as const });
	},
});

const runtime = ManagedRuntime.make(Layer.succeed(CronAdmin, adminStub));

beforeAll(() => {
	installServerFnRuntime(
		runtime,
		stubAuth(() => sessionUser(currentEmail)),
	);
});

afterAll(async () => {
	resetServerFnRuntime();
	await runtime.dispose();
});

const useSession = (email: string | null) => {
	currentEmail = email;
	serverFnRequestHeaders.current =
		email === null ? new Headers() : new Headers({ cookie: `session=id-${email}` });
};

describe("runCronJobFn", () => {
	it("fires a job id for admins", async () => {
		useSession("admin@x.com");
		runNowResult = { ok: true, summary: "done" };
		const res = await runCronJobFn({ data: { id: "agenda-reminders" } });
		expect(res).toEqual({ ok: true, summary: "done" });
		expect(runNowCalls.at(-1)).toBe("agenda-reminders");
	});

	it("propagates failure results", async () => {
		useSession("admin@x.com");
		runNowResult = { ok: false, reason: "unknown-job" };
		const res = await runCronJobFn({ data: { id: "missing" } });
		expect(res).toEqual({ ok: false, reason: "unknown-job" });
	});

	it("collapses Forbidden to the forbidden result shape", async () => {
		useSession("admin@x.com");
		runNowForbidden = true;
		const res = await runCronJobFn({ data: { id: "agenda-reminders" } });
		expect(res).toEqual({ ok: false, reason: "forbidden" });
		runNowForbidden = false;
	});

	it("rejects anonymous sessions", async () => {
		useSession(null);
		await expect(runCronJobFn({ data: { id: "agenda-reminders" } })).rejects.toThrow();
	});

	it("rejects an empty id at the schema boundary", async () => {
		useSession("admin@x.com");
		await expect(runCronJobFn({ data: { id: "" } })).rejects.toThrow();
	});
});

describe("schedule server fns", () => {
	it("creates a schedule for admins with createdBy stamped", async () => {
		useSession("admin@x.com");
		scheduleForbidden = false;
		scheduleCalls.length = 0;
		const res = await createScheduleFn({
			data: { kind: "agenda.sendReminder", cronExpr: "*/5 * * * *", params: { n: 1 } },
		});
		expect(res).toEqual({ ok: true, job: { id: "sched-1" } });
		expect(scheduleCalls[0]).toEqual([
			"create",
			{
				kind: "agenda.sendReminder",
				cronExpr: "*/5 * * * *",
				params: { n: 1 },
				createdBy: "id-admin@x.com",
			},
		]);
	});

	it("updates, deletes, and runs schedules", async () => {
		useSession("admin@x.com");
		scheduleCalls.length = 0;
		await updateScheduleFn({ data: { id: "sched-1", patch: { status: "paused" } } });
		await deleteScheduleFn({ data: { id: "sched-1" } });
		await runScheduleFn({ data: { id: "sched-1" } });
		expect(scheduleCalls).toEqual([
			["update", "sched-1", { status: "paused" }],
			["delete", "sched-1"],
			["run", "sched-1"],
		]);
	});

	it("collapses Forbidden to the unavailable/forbidden result shapes", async () => {
		useSession("admin@x.com");
		scheduleForbidden = true;
		expect(await createScheduleFn({ data: { kind: "k" } })).toEqual({
			ok: false,
			reason: "unavailable",
		});
		expect(await updateScheduleFn({ data: { id: "x", patch: {} } })).toEqual({
			ok: false,
			reason: "unavailable",
		});
		expect(await deleteScheduleFn({ data: { id: "x" } })).toEqual({
			ok: false,
			reason: "unavailable",
		});
		expect(await runScheduleFn({ data: { id: "x" } })).toEqual({
			ok: false,
			reason: "forbidden",
		});
		scheduleForbidden = false;
	});

	it("rejects anonymous sessions and invalid payloads", async () => {
		useSession(null);
		await expect(createScheduleFn({ data: { kind: "k" } })).rejects.toThrow();
		useSession("admin@x.com");
		await expect(createScheduleFn({ data: { kind: "" } })).rejects.toThrow();
		await expect(
			updateScheduleFn({ data: { id: "x", patch: { status: "bogus" } } }),
		).rejects.toThrow();
	});
});
