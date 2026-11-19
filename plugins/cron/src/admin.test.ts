import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { insertJobRun } from "@ktb/jobs-port";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { installServerFnRuntime, resetServerFnRuntime, stubAuth } from "@ktb/server-fns/testing";
import type { CronJobInfo, CronRunResult } from "@ktb/server-fns";

import { CronAdmin, CronAdminLive, type CronRunNowResult } from "./admin.ts";

const DDL = `
CREATE TABLE job_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', payload_ref TEXT, error TEXT, tenant_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

const db = makeDb(makeD1(DDL));

const adminGate = (admin: boolean) =>
	makePlatformAdminGate(parsePlatformAdminEmails(admin ? "admin@x.com" : ""));

const makeRuntime = (admin = true) =>
	ManagedRuntime.make(
		CronAdminLive.pipe(
			Layer.provide(
				Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, adminGate(admin))),
			),
		),
	);

const asPrincipal = <A>(
	runtime: ManagedRuntime.ManagedRuntime<CronAdmin, never>,
	effect: (a: CronAdmin["Service"]) => Effect.Effect<A, unknown, never>,
	email: string,
) =>
	runtime.runPromise(
		Effect.flatMap(CronAdmin, effect).pipe(
			Effect.provideService(Principal, { userId: "u1", email }),
		),
	);

const JOB: CronJobInfo = {
	id: "agenda-reminders",
	schedules: ["*/5 * * * *"],
	description: "Dispatch reminders",
	lastRun: null,
};

describe("CronAdminLive", () => {
	it("returns registry jobs and cron.* runs for admins", async () => {
		await insertJobRun(db, { id: "cron-r1", kind: "cron.agenda-reminders", status: "done" });
		await insertJobRun(db, { id: "other-r1", kind: "jobs.ping", status: "done" });
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				crons: {
					list: async () => [JOB],
					runNow: async () => null,
					runSchedule: async () => [],
				},
			},
		);
		const [jobs, runs] = await asPrincipal(
			runtime,
			(a) => Effect.all([a.jobs(), a.runs()]),
			"admin@x.com",
		);
		expect(jobs).toEqual([JOB]);
		// Only cron.* rows — the jobs.ping row must not leak into the feed.
		expect(runs?.map((r) => r.id)).toContain("cron-r1");
		expect(runs?.map((r) => r.id)).not.toContain("other-r1");
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("collapses a missing crons capability to null and runNow to unavailable", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{},
		);
		const [jobs] = await asPrincipal(runtime, (a) => Effect.all([a.jobs()]), "admin@x.com");
		expect(jobs).toBeNull();
		const result = await asPrincipal(runtime, (a) => a.runNow("agenda-reminders"), "admin@x.com");
		expect(result).toEqual({ ok: false, reason: "unavailable" });
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("runNow maps registry outcomes to console results", async () => {
		const outcomes: Record<string, CronRunResult | null> = {
			"agenda-reminders": { id: "agenda-reminders", ok: true, summary: "2 reminders" },
			"audit-chain-verify": { id: "audit-chain-verify", ok: false, error: "walk failed" },
		};
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				crons: {
					list: async () => [JOB],
					runNow: async (id) => outcomes[id] ?? null,
					runSchedule: async () => [],
				},
			},
		);
		const ok: CronRunNowResult = await asPrincipal(
			runtime,
			(a) => a.runNow("agenda-reminders"),
			"admin@x.com",
		);
		expect(ok).toEqual({ ok: true, summary: "2 reminders" });
		const failed: CronRunNowResult = await asPrincipal(
			runtime,
			(a) => a.runNow("audit-chain-verify"),
			"admin@x.com",
		);
		expect(failed).toEqual({ ok: false, reason: "run-failed", error: "walk failed" });
		const unknown: CronRunNowResult = await asPrincipal(
			runtime,
			(a) => a.runNow("missing"),
			"admin@x.com",
		);
		expect(unknown).toEqual({ ok: false, reason: "unknown-job" });
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("collapses throwing probes to null and dispatch failures to run-failed", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				crons: {
					list: async () => {
						throw new Error("registry gone");
					},
					runNow: async () => {
						throw new Error("dispatch exploded");
					},
					runSchedule: async () => [],
				},
			},
		);
		const [jobs] = await asPrincipal(runtime, (a) => Effect.all([a.jobs()]), "admin@x.com");
		expect(jobs).toBeNull();
		const result: CronRunNowResult = await asPrincipal(
			runtime,
			(a) => a.runNow("agenda-reminders"),
			"admin@x.com",
		);
		expect(result).toEqual({ ok: false, reason: "run-failed", error: "dispatch failed" });
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("collapses an unreadable job_runs projection to null", async () => {
		// No job_runs DDL — the projection read throws and the console
		// degrades to the unavailable state instead of failing the page.
		const runtime = ManagedRuntime.make(
			CronAdminLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(Db, makeDb(makeD1())),
						Layer.succeed(PlatformAdmin, adminGate(true)),
					),
				),
			),
		);
		const runs = await asPrincipal(runtime, (a) => a.runs(), "admin@x.com");
		expect(runs).toBeNull();
		await runtime.dispose();
	});

	it("maps a throwing crons capability accessor to unavailable", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				get crons(): never {
					throw new Error("registry accessor exploded");
				},
			},
		);
		const result = await asPrincipal(runtime, (a) => a.runNow("agenda-reminders"), "admin@x.com");
		expect(result).toEqual({ ok: false, reason: "unavailable" });
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("rejects non-admins with Forbidden on every method", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{},
		);
		for (const call of [
			(a: CronAdmin["Service"]) => a.jobs(),
			(a: CronAdmin["Service"]) => a.runs(),
			(a: CronAdmin["Service"]) => a.runNow("agenda-reminders"),
		] as const) {
			const exit = await runtime.runPromiseExit(
				Effect.flatMap(CronAdmin, (a) => call(a) as Effect.Effect<unknown, unknown, never>).pipe(
					Effect.provideService(Principal, { userId: "u1", email: "doc@x.com" }),
				),
			);
			expect(exit._tag).toBe("Failure");
		}
		await runtime.dispose();
		resetServerFnRuntime();
	});
});
