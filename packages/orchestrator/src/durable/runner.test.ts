import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import { makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { orchestrationRuns } from "../schema.ts";

import { eq } from "drizzle-orm";
import type { JobEnvelope, JobsEnqueuer } from "@ktb/jobs-port";
import { TenantAccess } from "@ktb/tenant";

import { makeOrchestratorRegistry } from "../registry.ts";
import {
	createOrchestrationSession,
	OrchestrationEvent,
	type NodeContext,
	type OrchestrationDef,
	type OrchestrationKind,
	type OrchestrationNode,
} from "../index.ts";
import {
	createOrchestrationRun,
	getOrchestrationRun,
	listNodeRuns,
	listPendingEvents,
	loadOrchestrationRun,
} from "./store.ts";
import {
	makeOrchestrationRunner,
	ORCHESTRATOR_STEP_KIND,
	orchestratorStepRegistration,
	type OrchestrationRunnerService,
} from "./runner.ts";

const makeTestDb = (): DbClient => makeDb(makeTestD1());

/** Capturing enqueuer — the fake transport. `sent` records the
 * enqueue options too so tests can assert the tenantId envelope. */
const fakeJobs = (fail?: { at?: number; value?: unknown }) => {
	const sent: {
		kind: string;
		payload: unknown;
		options?: { tenantId?: string | number | null };
	}[] = [];
	let calls = 0;
	const jobs: JobsEnqueuer = {
		enqueue: async (kind, payload, options): Promise<JobEnvelope> => {
			calls += 1;
			if (fail?.at !== undefined && calls === fail.at) {
				throw fail.value ?? new Error("queue down");
			}
			sent.push({ kind, payload, options });
			return { id: `job-${calls}`, kind, payload, tenantId: options?.tenantId ?? null };
		},
	};
	return { jobs, sent };
};

const node = (
	id: string,
	kindId: string,
	on: readonly string[],
	extra?: Partial<OrchestrationNode>,
): OrchestrationNode => ({ id, kind: kindId, on, emits: [], ...extra });

const def = (
	id: string,
	nodes: readonly OrchestrationNode[],
	extra?: Partial<OrchestrationDef>,
) => ({
	id,
	...extra,
	nodes,
});

/** A kind that counts fires into run state — proves state survives
 * step boundaries (resume correctness). */
const counterKind = (id: string, emitType?: string): OrchestrationKind => ({
	id,
	run: (ctx: NodeContext) =>
		Effect.gen(function* () {
			const n = typeof ctx.state["n"] === "number" ? (ctx.state["n"] as number) : 0;
			if (emitType !== undefined) yield* ctx.emit(emitType, {});
			return { state: { n: n + 1 }, output: { n: n + 1 } };
		}),
});

const passthroughKind = (id: string): OrchestrationKind => ({
	id,
	run: () => Effect.succeed({}),
});

interface Harness {
	readonly db: DbClient;
	readonly registry: ReturnType<typeof makeOrchestratorRegistry>;
	readonly runner: OrchestrationRunnerService;
	readonly sent: {
		kind: string;
		payload: unknown;
		options?: { tenantId?: string | number | null };
	}[];
	readonly registration: ReturnType<typeof orchestratorStepRegistration>;
}

const harness = (opts?: {
	kinds?: readonly OrchestrationKind[];
	batchSize?: number;
	failEnqueue?: { at?: number; value?: unknown };
}): Harness => {
	const db = makeTestDb();
	const registry = makeOrchestratorRegistry(opts?.kinds ?? []);
	const { jobs, sent } = fakeJobs(opts?.failEnqueue);
	const base = { db, registry, sent };
	const runner = makeOrchestrationRunner({
		db: base.db,
		jobs,
		registry: base.registry,
		batchSize: opts?.batchSize,
	});
	return { ...base, runner, registration: orchestratorStepRegistration(runner) };
};

/** Drive every enqueued step job through the registration — the fake
 * consumer. Jobs enqueued while draining are processed too (FIFO). */
const drain = async (h: Harness): Promise<void> => {
	for (let i = 0; i < h.sent.length; i += 1) {
		const job = h.sent[i] as { kind: string; payload: unknown };
		const payload = h.registration.decodePayload?.(job.payload);
		await h.registration.handle(payload, {
			id: `env-${i}`,
			kind: job.kind,
			payload: job.payload,
		});
	}
};

const runStatus = async (db: DbClient, runId: string) =>
	(await getOrchestrationRun(db, runId))?.status;

describe("makeOrchestrationRunner.start", () => {
	it("persists the run + seed event and enqueues the first step job", async () => {
		const h = harness({ kinds: [passthroughKind("noop")] });
		h.registry.registerDef(def("d", [node("a", "noop", ["start"])]));
		const runId = await Effect.runPromise(h.runner.start("d", { hello: 1 }));
		expect(runId).toMatch(/^orun-/);
		const record = await getOrchestrationRun(h.db, runId);
		expect(record).toMatchObject({ defId: "d", defVersion: "1", status: "running" });
		const pending = await listPendingEvents(h.db, runId);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.event).toMatchObject({ type: "input", source: "run" });
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({
			kind: ORCHESTRATOR_STEP_KIND,
			payload: { runId },
		});
	});

	it("fails on unknown def and on unresolvable kinds before writing rows", async () => {
		const h = harness({ kinds: [passthroughKind("noop")] });
		const exit = await Effect.runPromise(Effect.exit(h.runner.start("ghost")));
		expect(exit._tag).toBe("Failure");
		// Mutate a registered def post-registration — start re-validates
		// kind resolution before writing any rows.
		const d = def("bad", [node("a", "noop", ["start"])]);
		h.registry.registerDef(d);
		(d.nodes as OrchestrationNode[]).push(node("x", "missing", ["start"]));
		const exit2 = await Effect.runPromise(Effect.exit(h.runner.start("bad")));
		expect(exit2._tag).toBe("Failure");
		expect(await h.db.select().from(orchestrationRuns)).toHaveLength(0);
	});

	it("records nameless and non-Error enqueue failures in the run error", async () => {
		// Error with empty message and no _tag → error.name; a thrown
		// non-Error → String(error).
		for (const [value, expected] of [
			[new Error(), "Error"],
			["string boom", "string boom"],
		] as const) {
			const h = harness({ kinds: [passthroughKind("noop")], failEnqueue: { at: 1, value } });
			h.registry.registerDef(def("d", [node("a", "noop", ["start"])]));
			const exit = await Effect.runPromise(Effect.exit(h.runner.start("d")));
			expect(exit._tag).toBe("Failure");
			const runs = await h.db.select().from(orchestrationRuns);
			expect(runs[0]?.status).toBe("failed");
			expect(runs[0]?.error).toContain(expected);
		}
	});

	it("marks the run failed when the initial enqueue fails", async () => {
		const h = harness({ kinds: [passthroughKind("noop")], failEnqueue: { at: 1 } });
		h.registry.registerDef(def("d", [node("a", "noop", ["start"])]));
		const exit = await Effect.runPromise(Effect.exit(h.runner.start("d")));
		expect(exit._tag).toBe("Failure");
		const runs = await h.db.select().from(orchestrationRuns);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("failed");
		expect(runs[0]?.error).toContain("step enqueue failed");
	});
});

describe("durable step execution", () => {
	it("drives a multi-event run to done across step jobs, one batch at a time", async () => {
		const h = harness({
			kinds: [counterKind("count", "tick"), passthroughKind("noop")],
			batchSize: 1,
		});
		h.registry.registerDef(
			def("chain", [node("a", "count", ["input"], { params: {} }), node("b", "noop", ["tick"])]),
		);
		const runId = await Effect.runPromise(h.runner.start("chain", {}));
		await drain(h);
		const record = await getOrchestrationRun(h.db, runId);
		expect(record?.status).toBe("done");
		// a fired once on "input" and emitted "tick"; b absorbed "tick";
		// workflow.done closed the run. State carried across steps.
		const loaded = await loadOrchestrationRun(h.db, runId);
		expect(loaded?.runtime?.state).toMatchObject({ n: 1 });
		expect(loaded?.pending).toEqual([]);
		const nodeRuns = await listNodeRuns(h.db, runId);
		expect(nodeRuns.map((r) => r.nodeId)).toEqual(["a", "b"]);
		expect(nodeRuns.every((r) => r.status === "ok")).toBe(true);
		// Every enqueued job was a step job for this run.
		expect(h.sent.every((j) => j.kind === ORCHESTRATOR_STEP_KIND)).toBe(true);
		expect(h.sent.length).toBeGreaterThan(1);
	});

	it("resumes after a simulated worker crash — state, queue and trace all come from the db", async () => {
		// batchSize 1 → each step persists a boundary; a "crash" is just a
		// new runner instance over the same db (the runner holds no run state).
		const db = makeTestDb();
		const registry = makeOrchestratorRegistry([counterKind("count", "tick")]);
		registry.registerDef(def("crash", [node("a", "count", ["input"])]));
		const { jobs, sent } = fakeJobs();
		const runner1 = makeOrchestrationRunner({ db, jobs, registry, batchSize: 1 });
		const runId = await Effect.runPromise(runner1.start("crash", {}));

		// Step 1 (fresh runner) — processes "input", emits "tick", persists.
		const runner2 = makeOrchestrationRunner({ db, jobs, registry, batchSize: 1 });
		await Effect.runPromise(runner2.step(runId));
		const mid = await loadOrchestrationRun(db, runId);
		expect(mid?.record.status).toBe("running");
		expect(mid?.pending.map((p) => p.event.type)).toEqual(["tick"]);

		// "Crash": runner3 knows nothing in memory — resume purely from db.
		// Step B: "tick" is unrouted (node a listens only to "input"), so
		// the queue drains with batch=1 stopping before the done emit.
		const runner3 = makeOrchestrationRunner({ db, jobs, registry, batchSize: 1 });
		await Effect.runPromise(runner3.step(runId));
		const mid2 = await loadOrchestrationRun(db, runId);
		expect(mid2?.record.status).toBe("running");
		expect(mid2?.pending).toEqual([]);

		// Step C: empty queue + !doneEmitted → workflow.done → quiesce.
		await Effect.runPromise(runner3.step(runId));
		const done = await getOrchestrationRun(db, runId);
		expect(done?.status).toBe("done");
		const final = await loadOrchestrationRun(db, runId);
		expect(final?.runtime?.state).toMatchObject({ a: { n: 1 }, n: 1 });
		expect(sent.length).toBeGreaterThan(0);
	});

	it("preserves pending-event order across steps", async () => {
		// Custom kind emitting two events in order on "input".
		const emit2: OrchestrationKind = {
			id: "emit2",
			run: (ctx) =>
				Effect.gen(function* () {
					yield* ctx.emit("first", { i: 1 });
					yield* ctx.emit("second", { i: 2 });
					return {};
				}),
		};
		const h2 = harness({ kinds: [emit2], batchSize: 1 });
		h2.registry.registerDef(def("ord", [node("a", "emit2", ["input"])]));
		const runId = await Effect.runPromise(h2.runner.start("ord", {}));
		await Effect.runPromise(h2.runner.step(runId));
		const pending = await listPendingEvents(h2.db, runId);
		expect(pending.map((p) => p.event.type)).toEqual(["first", "second"]);
		expect(pending.map((p) => p.seq)).toEqual([0, 1]);
	});

	it("marks the run failed on node halt and keeps the trace", async () => {
		const failing: OrchestrationKind = {
			id: "boom",
			run: () => Effect.fail(new Error("node exploded")),
		};
		const h = harness({ kinds: [failing] });
		h.registry.registerDef(def("f", [node("a", "boom", ["start"])]));
		const runId = await Effect.runPromise(h.runner.start("f"));
		await drain(h);
		const record = await getOrchestrationRun(h.db, runId);
		expect(record?.status).toBe("failed");
		const nodeRuns = await listNodeRuns(h.db, runId);
		expect(nodeRuns[0]).toMatchObject({ nodeId: "a", status: "failed" });
		// Failed runs do not enqueue further steps.
		await Effect.runPromise(h.runner.step(runId)); // idempotent no-op
		expect(await runStatus(h.db, runId)).toBe("failed");
	});

	it("marks the run failed when the event budget is exceeded", async () => {
		// Self-emitting kind: every fire re-emits its own trigger type.
		const looper: OrchestrationKind = {
			id: "loop",
			run: (ctx) => Effect.succeed({ events: [{ type: ctx.event.type, payload: {} }] }),
		};
		const h = harness({ kinds: [looper] });
		h.registry.registerDef(def("spin", [node("a", "loop", ["input"])]));
		const runId = await Effect.runPromise(h.runner.start("spin", {}, { maxEvents: 4 }));
		await drain(h);
		const record = await getOrchestrationRun(h.db, runId);
		expect(record?.status).toBe("failed");
		expect(record?.error).toContain("event budget exceeded");
	});

	it("marks the run cancelled on workflow.cancel", async () => {
		const h = harness({ kinds: [passthroughKind("noop")] });
		h.registry.registerDef(def("c", [node("a", "noop", ["workflow.cancel"])]));
		const runId = await Effect.runPromise(
			h.runner.start("c", OrchestrationEvent.cancel("user asked")),
		);
		await drain(h);
		expect(await runStatus(h.db, runId)).toBe("cancelled");
	});

	it("fails the run when the def is gone from the registry at step time", async () => {
		const h = harness({ kinds: [passthroughKind("noop")] });
		// Simulate def removal: the registry has no unregister, so write a
		// run row pointing at a defId the registry does not know.
		const session = await Effect.runPromise(
			createOrchestrationSession(
				def("real", [node("a", "noop", ["start"])]),
				new Map([["noop", passthroughKind("noop")]]),
			),
		);
		await createOrchestrationRun(h.db, {
			id: "ghost-run",
			defId: "ghost",
			defVersion: "1",
			snapshot: session.snapshot(),
			initialEvent: OrchestrationEvent.start(),
		});
		await Effect.runPromise(h.runner.step("ghost-run"));
		const record = await getOrchestrationRun(h.db, "ghost-run");
		expect(record?.status).toBe("failed");
		// UnknownOrchestrationError has no message field — the tag lands.
		expect(record?.error).toBe("UnknownOrchestrationError");
	});

	it("fails the run when the stored runtime snapshot is corrupt", async () => {
		const h = harness({ kinds: [passthroughKind("noop")] });
		h.registry.registerDef(def("d", [node("a", "noop", ["start"])]));
		const runId = await Effect.runPromise(h.runner.start("d"));
		await h.db
			.update(orchestrationRuns)
			.set({ runtime: "{corrupt" })
			.where(eq(orchestrationRuns.id, runId));
		await Effect.runPromise(h.runner.step(runId));
		const record = await getOrchestrationRun(h.db, runId);
		expect(record?.status).toBe("failed");
		expect(record?.error).toContain("corrupt run state");
	});

	it("provides ambientContext services to kind probes during steps", async () => {
		// A kind probing an ambient port via Effect.serviceOption — the
		// EnvCorrector idiom — resolves it ONLY when the runner was
		// built with ambientContext; without it the probe degrades.
		class AmbientProbe extends Context.Service<AmbientProbe, { readonly ping: () => string }>()(
			"@ktb/orchestrator-test/AmbientProbe",
		) {}
		const probeKind = (id: string): OrchestrationKind => ({
			id,
			run: () =>
				Effect.gen(function* () {
					const svc = yield* Effect.serviceOption(AmbientProbe);
					const seen = Option.isSome(svc) ? svc.value.ping() : "none";
					return { state: { seen }, output: { seen } };
				}),
		});
		const db = makeTestDb();
		const registry = makeOrchestratorRegistry([probeKind("probe")]);
		registry.registerDef(def("p", [node("a", "probe", ["input"])]));
		const { jobs } = fakeJobs();
		const runner = makeOrchestrationRunner({
			db,
			jobs,
			registry,
			ambientContext: Context.make(AmbientProbe, { ping: () => "pong" }),
		});
		const runId = await Effect.runPromise(runner.start("p", {}));
		await Effect.runPromise(runner.step(runId));
		const loaded = await loadOrchestrationRun(db, runId);
		expect(loaded?.record.status).toBe("done");
		expect(loaded?.runtime?.state["seen"]).toBe("pong");

		// Same run shape without ambientContext — the probe misses.
		const db2 = makeTestDb();
		const registry2 = makeOrchestratorRegistry([probeKind("probe")]);
		registry2.registerDef(def("p", [node("a", "probe", ["input"])]));
		const { jobs: jobs2 } = fakeJobs();
		const runner2 = makeOrchestrationRunner({ db: db2, jobs: jobs2, registry: registry2 });
		const runId2 = await Effect.runPromise(runner2.start("p", {}));
		await Effect.runPromise(runner2.step(runId2));
		const loaded2 = await loadOrchestrationRun(db2, runId2);
		expect(loaded2?.runtime?.state["seen"]).toBe("none");
	});

	it("stamps tenant_id on the run row and the step envelope", async () => {
		const h = harness({ kinds: [passthroughKind("noop")] });
		h.registry.registerDef(def("d", [node("a", "noop", ["start"])]));
		const runId = await Effect.runPromise(h.runner.start("d", {}, undefined, 7));
		expect((await getOrchestrationRun(h.db, runId))?.tenantId).toBe(7);
		expect(h.sent[0]?.options?.tenantId).toBe(7);
		// Absent tenantId → NULL row + null envelope option.
		const runId2 = await Effect.runPromise(h.runner.start("d"));
		expect((await getOrchestrationRun(h.db, runId2))?.tenantId).toBeNull();
		expect(h.sent[1]?.options?.tenantId).toBeNull();
	});

	it("re-binds TenantAccess from the run's tenant_id during steps", async () => {
		// A kind probing TenantAccess — the scoped-repo fence — sees the
		// run's tenant, not ambient scope. Runs both with and without an
		// ambientContext (the two provide paths).
		const probe: OrchestrationKind = {
			id: "tenant-probe",
			run: () =>
				Effect.gen(function* () {
					const access = yield* TenantAccess;
					return {
						state: { access: access === null ? "ambient" : access.join(",") },
						output: {},
					};
				}),
		};
		for (const ambientContext of [undefined, Context.empty()] as const) {
			const db = makeTestDb();
			const registry = makeOrchestratorRegistry([probe]);
			registry.registerDef(def("tp", [node("a", "tenant-probe", ["input"])]));
			const { jobs } = fakeJobs();
			const runner = makeOrchestrationRunner({
				db,
				jobs,
				registry,
				...(ambientContext === undefined ? {} : { ambientContext }),
			});
			const tenantRun = await Effect.runPromise(runner.start("tp", {}, undefined, 7));
			await Effect.runPromise(runner.step(tenantRun));
			expect((await loadOrchestrationRun(db, tenantRun))?.runtime?.state["access"]).toBe("7");
			// NULL-tenant run keeps ambient scope.
			const globalRun = await Effect.runPromise(runner.start("tp", {}));
			await Effect.runPromise(runner.step(globalRun));
			expect((await loadOrchestrationRun(db, globalRun))?.runtime?.state["access"]).toBe("ambient");
		}
	});

	it("carries the run's tenantId on continuation step envelopes", async () => {
		const h = harness({
			kinds: [counterKind("count", "tick"), passthroughKind("noop")],
			batchSize: 1,
		});
		h.registry.registerDef(
			def("chain", [node("a", "count", ["input"], { params: {} }), node("b", "noop", ["tick"])]),
		);
		const runId = await Effect.runPromise(h.runner.start("chain", {}, undefined, 9));
		expect(h.sent[0]?.options?.tenantId).toBe(9);
		// First step leaves the run unfinished → continuation enqueue
		// reads tenant_id back off the run row.
		await Effect.runPromise(h.runner.step(runId));
		expect(h.sent.length).toBeGreaterThan(1);
		expect(h.sent.at(-1)?.options?.tenantId).toBe(9);
	});

	it("step on a missing run is a no-op", async () => {
		const h = harness({ kinds: [] });
		await Effect.runPromise(h.runner.step("nope"));
		expect(await getOrchestrationRun(h.db, "nope")).toBeNull();
	});

	it("defects when the continuation enqueue fails mid-run", async () => {
		// First enqueue (start) succeeds, second (continuation) fails.
		const db = makeTestDb();
		const registry = makeOrchestratorRegistry([counterKind("count", "tick")]);
		registry.registerDef(def("d", [node("a", "count", ["input"])]));
		const { jobs, sent } = fakeJobs({ at: 2 });
		const runner = makeOrchestrationRunner({ db, jobs, registry, batchSize: 1 });
		const runId = await Effect.runPromise(runner.start("d", {}));
		// First step: batch=1 processes "input", emits "tick", persists,
		// then the continuation enqueue is call #2 → throws → defect.
		const exit = await Effect.runPromise(Effect.exit(runner.step(runId)));
		expect(exit._tag).toBe("Failure");
		// The boundary persisted BEFORE the enqueue — run still running
		// with "tick" pending; a retry continues it.
		const loaded = await loadOrchestrationRun(db, runId);
		expect(loaded?.record.status).toBe("running");
		expect(loaded?.pending.map((p) => p.event.type)).toEqual(["tick"]);
		// Only the start enqueue succeeded — the continuation defected.
		expect(sent).toHaveLength(1);
	});
});

describe("orchestratorStepRegistration", () => {
	it("decodes {runId} payloads and rejects poison", async () => {
		const h = harness({ kinds: [] });
		const reg = h.registration;
		expect(reg.decodePayload?.({ runId: "r1" })).toEqual({ runId: "r1" });
		expect(() => reg.decodePayload?.({ nope: 1 })).toThrow(/runId/);
		expect(reg.idempotent).toBe(true);
	});

	it("handle runs one step for the payload runId", async () => {
		const h = harness({ kinds: [passthroughKind("noop")] });
		h.registry.registerDef(def("d", [node("a", "noop", ["start"])]));
		const runId = await Effect.runPromise(h.runner.start("d"));
		await h.registration.handle(
			{ runId },
			{ id: "j1", kind: ORCHESTRATOR_STEP_KIND, payload: { runId } },
		);
		expect(h.sent.length).toBeGreaterThanOrEqual(1);
	});
});
