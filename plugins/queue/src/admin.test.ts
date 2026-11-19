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
import type { JobsEnqueuer } from "@ktb/server-fns";

import { QueueAdmin, QueueAdminLive } from "./admin.ts";

const DDL = `
CREATE TABLE job_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', payload_ref TEXT, error TEXT, tenant_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;

const db = makeDb(makeD1(DDL));

const adminGate = (admin: boolean) =>
	makePlatformAdminGate(parsePlatformAdminEmails(admin ? "admin@x.com" : ""));

const makeRuntime = (admin = true) =>
	ManagedRuntime.make(
		QueueAdminLive.pipe(
			Layer.provide(
				Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, adminGate(admin))),
			),
		),
	);

const asPrincipal = <A>(
	runtime: ManagedRuntime.ManagedRuntime<QueueAdmin, never>,
	effect: (a: QueueAdmin["Service"]) => Effect.Effect<A, unknown, never>,
	email: string,
) =>
	runtime.runPromise(
		Effect.flatMap(QueueAdmin, effect).pipe(
			Effect.provideService(Principal, { userId: "u1", email }),
		),
	);

describe("QueueAdminLive", () => {
	it("returns registry queues, job runs and kinds for admins", async () => {
		await insertJobRun(db, { id: "admin-r1", kind: "jobs.ping", status: "done" });
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{
				queues: async () => [
					{
						id: "jobs",
						name: "ktb:jobs",
						transport: "redis",
						consumer: "jobs-worker",
						depth: { pending: 1, processing: 0, done: 2, failed: 0 },
					},
				],
			},
		);
		const [queues, runs, kinds] = await asPrincipal(
			runtime,
			(a) => Effect.all([a.queues(), a.jobRuns(), a.kinds()]),
			"admin@x.com",
		);
		expect(queues).toHaveLength(1);
		expect(queues?.[0]?.transport).toBe("redis");
		expect(runs?.map((r) => r.id)).toContain("admin-r1");
		expect(kinds).toContain("jobs.ping");
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("collapses a missing queues probe to null and a missing jobs port to unavailable", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{},
		);
		const [queues] = await asPrincipal(runtime, (a) => Effect.all([a.queues()]), "admin@x.com");
		expect(queues).toBeNull();
		const result = await asPrincipal(runtime, (a) => a.enqueue("jobs.ping"), "admin@x.com");
		expect(result).toEqual({ ok: false, reason: "unavailable" });
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("degrades queues to null when the registry probe rejects", async () => {
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{ queues: () => Promise.reject(new Error("probe down")) },
		);
		const [queues] = await asPrincipal(runtime, (a) => Effect.all([a.queues()]), "admin@x.com");
		expect(queues).toBeNull();
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("degrades queues and enqueue when the server runtime is absent", async () => {
		const runtime = makeRuntime();
		// No installServerFnRuntime: getServerRuntime() throws inside both
		// degradation arms.
		resetServerFnRuntime();
		const queues = await asPrincipal(runtime, (a) => a.queues(), "admin@x.com");
		expect(queues).toBeNull();
		const result = await asPrincipal(runtime, (a) => a.enqueue("jobs.ping"), "admin@x.com");
		expect(result).toEqual({ ok: false, reason: "unavailable" });
		await runtime.dispose();
	});

	it("degrades jobRuns to null when the projection read fails", async () => {
		const runtime = ManagedRuntime.make(
			QueueAdminLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						// No job_runs DDL — the projection read throws.
						Layer.succeed(Db, makeDb(makeD1())),
						Layer.succeed(PlatformAdmin, adminGate(true)),
					),
				),
			),
		);
		const runs = await asPrincipal(runtime, (a) => a.jobRuns(), "admin@x.com");
		expect(runs).toBeNull();
		await runtime.dispose();
	});

	it("enqueue sends through the runtime jobs port", async () => {
		const sent: { kind: string; payload: unknown }[] = [];
		const jobs: JobsEnqueuer = {
			enqueue: (kind, payload) => {
				sent.push({ kind, payload });
				return Promise.resolve({});
			},
		};
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{ jobs },
		);
		const result = await asPrincipal(
			runtime,
			(a) => a.enqueue("jobs.ping", { hello: 1 }),
			"admin@x.com",
		);
		expect(result).toEqual({ ok: true });
		expect(sent).toEqual([{ kind: "jobs.ping", payload: { hello: 1 } }]);
		await runtime.dispose();
		resetServerFnRuntime();
	});

	it("enqueue reports enqueue-failed when the transport rejects", async () => {
		const jobs: JobsEnqueuer = {
			enqueue: () => Promise.reject(new Error("queue down")),
		};
		const runtime = makeRuntime();
		installServerFnRuntime(
			runtime,
			stubAuth(() => null),
			{ jobs },
		);
		const result = await asPrincipal(runtime, (a) => a.enqueue("jobs.ping"), "admin@x.com");
		expect(result).toEqual({ ok: false, reason: "enqueue-failed" });
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
			(a: QueueAdmin["Service"]) => a.queues(),
			(a: QueueAdmin["Service"]) => a.jobRuns(),
			(a: QueueAdmin["Service"]) => a.kinds(),
			(a: QueueAdmin["Service"]) => a.enqueue("jobs.ping"),
		] as const) {
			const exit = await runtime.runPromiseExit(
				Effect.flatMap(QueueAdmin, (a) => call(a) as Effect.Effect<unknown, unknown, never>).pipe(
					Effect.provideService(Principal, { userId: "u1", email: "doc@x.com" }),
				),
			);
			expect(exit._tag).toBe("Failure");
		}
		await runtime.dispose();
		resetServerFnRuntime();
	});
});
