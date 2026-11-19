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

import { CronAdmin, type CronRunNowResult } from "./admin.ts";
import { runCronJobFn } from "./fns.ts";

let currentEmail: string | null = "admin@x.com";
let runNowResult: CronRunNowResult = { ok: true };
let runNowForbidden = false;
const runNowCalls: string[] = [];

const adminStub = CronAdmin.of({
	jobs: () => Effect.succeed(null),
	runs: () => Effect.succeed([]),
	runNow: (id) => {
		runNowCalls.push(id);
		return runNowForbidden
			? Effect.fail(new Forbidden({ path: "platform.admin" }))
			: Effect.succeed(runNowResult);
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
