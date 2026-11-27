import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vitest";

import { makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { jobHandlers, type JobEnvelope, type JobsEnqueuer } from "@ktb/jobs-port";
import {
	getOrchestrationRun,
	makeOrchestratorRegistry,
	ORCHESTRATOR_STEP_KIND,
	OrchestratorRegistry,
	upsertOrchestrationDef,
	type OrchestrationDef,
	type OrchestrationKind,
	type OrchestrationNode,
} from "@ktb/orchestrator";

import { makeOrchestrationHost } from "./orchestration.ts";

const makeTestDb = (): DbClient => makeDb(makeTestD1());

/** Capturing enqueuer — the fake transport (same shape the
 * orchestrator package's own runner tests use). */
const fakeJobs = () => {
	const sent: {
		kind: string;
		payload: unknown;
		options?: { tenantId?: string | number | null };
	}[] = [];
	const jobs: JobsEnqueuer = {
		enqueue: async (kind, payload, options): Promise<JobEnvelope> => {
			sent.push({ kind, payload, options });
			return { id: `job-${sent.length}`, kind, payload, tenantId: options?.tenantId ?? null };
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

const def = (id: string, nodes: readonly OrchestrationNode[]): OrchestrationDef => ({
	id,
	nodes,
});

const noopKind: OrchestrationKind = { id: "noop", run: () => Effect.succeed({}) };

/** Ambient probe — stands in for EnvCorrector/PlatformLlm & friends:
 * a service the composition runtime binds and the durable step's
 * ambientContext must carry into kind executions. */
class AmbientProbe extends Context.Service<AmbientProbe, { readonly ping: () => string }>()(
	"@ktb/web-test/AmbientProbe",
) {}

const probeKind: OrchestrationKind = {
	id: "probe",
	run: () =>
		Effect.gen(function* () {
			const svc = yield* Effect.serviceOption(AmbientProbe);
			const seen = Option.isSome(svc) ? svc.value.ping() : "none";
			return { state: { seen }, output: { seen } };
		}),
};

interface HostHarness {
	readonly host: ReturnType<typeof makeOrchestrationHost>;
	readonly db: DbClient;
	readonly registry: ReturnType<typeof makeOrchestratorRegistry>;
	readonly sent: {
		kind: string;
		payload: unknown;
		options?: { tenantId?: string | number | null };
	}[];
}

/** `run` mimics lib/platform.ts's: executes the effect against a
 * context carrying the registry + the ambient probe — the same shape
 * the real app runtime provides (OrchestratorRegistryLive in core,
 * plugin/env ports as siblings). */
const harness = (opts?: {
	readonly kinds?: readonly OrchestrationKind[];
	readonly defs?: readonly OrchestrationDef[];
	readonly rejectRuns?: number;
}): HostHarness => {
	const db = makeTestDb();
	const registry = makeOrchestratorRegistry(opts?.kinds ?? []);
	for (const d of opts?.defs ?? []) registry.registerDef(d);
	const { jobs, sent } = fakeJobs();
	let runCalls = 0;
	const run = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> => {
		runCalls += 1;
		if (opts?.rejectRuns !== undefined && runCalls <= opts.rejectRuns) {
			return Promise.reject(new Error("runtime down"));
		}
		// `run` mirrors lib/platform.ts's signature (Effect<A, E,
		// unknown>); provideService can't narrow `unknown`, so the
		// provided effect is asserted to its fully-provided shape —
		// the same trust app.run places in its ManagedRuntime context.
		return Effect.runPromise(
			effect.pipe(
				Effect.provideService(OrchestratorRegistry, registry),
				Effect.provideService(AmbientProbe, { ping: () => "pong" }),
			) as Effect.Effect<A, E>,
		);
	};
	return { host: makeOrchestrationHost({ run, db, jobs }), db, registry, sent };
};

afterEach(() => {
	delete jobHandlers[ORCHESTRATOR_STEP_KIND];
});

describe("makeOrchestrationHost", () => {
	it("registers orchestrator.step: decodes {runId}, is idempotent, and drives a run to done", async () => {
		const h = harness({ kinds: [noopKind] });
		// "input" — startRun's payload becomes the run's initial event.
		h.registry.registerDef(def("d", [node("a", "noop", ["input"])]));
		h.host.registerStepHandler();

		const registration = jobHandlers[ORCHESTRATOR_STEP_KIND];
		expect(registration).toBeDefined();
		expect(registration?.idempotent).toBe(true);
		expect(registration?.decodePayload?.({ runId: "r1" })).toEqual({ runId: "r1" });
		expect(() => registration?.decodePayload?.({ nope: 1 })).toThrow(/runId/);

		// startRun persists the run and enqueues step 1.
		const runId = await h.host.startRun("d", { hello: 1 });
		expect(runId).toMatch(/^orun-/);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toMatchObject({
			kind: ORCHESTRATOR_STEP_KIND,
			payload: { runId },
		});

		// Consumer path: decode + handle the enqueued job.
		const payload = registration?.decodePayload?.(h.sent[0]?.payload);
		await registration?.handle(payload, {
			id: "env-0",
			kind: ORCHESTRATOR_STEP_KIND,
			payload: h.sent[0]?.payload,
		});
		expect((await getOrchestrationRun(h.db, runId))?.status).toBe("done");
	});

	it("carries ambient runtime services into kind probes during steps", async () => {
		const h = harness({ kinds: [probeKind] });
		h.registry.registerDef(def("p", [node("a", "probe", ["input"])]));
		h.host.registerStepHandler();

		const runId = await h.host.startRun("p", {});
		const registration = jobHandlers[ORCHESTRATOR_STEP_KIND];
		const payload = registration?.decodePayload?.(h.sent[0]?.payload);
		await registration?.handle(payload, {
			id: "env-0",
			kind: ORCHESTRATOR_STEP_KIND,
			payload: h.sent[0]?.payload,
		});
		const record = await getOrchestrationRun(h.db, runId);
		expect(record?.status).toBe("done");
		// The probe resolved AmbientProbe from the captured ambient
		// context — without it the kind would have recorded "none".
		expect(record?.state["seen"]).toBe("pong");
	});

	it("stamps tenantId on the run row and the step envelope", async () => {
		const h = harness({ kinds: [noopKind] });
		h.registry.registerDef(def("d", [node("a", "noop", ["input"])]));
		const runId = await h.host.startRun("d", {}, undefined, 7);
		expect((await getOrchestrationRun(h.db, runId))?.tenantId).toBe(7);
		expect(h.sent[0]?.options?.tenantId).toBe(7);
		// Omitted tenantId → NULL row + null envelope option.
		const globalRun = await h.host.startRun("d");
		expect((await getOrchestrationRun(h.db, globalRun))?.tenantId).toBeNull();
		expect(h.sent[1]?.options?.tenantId).toBeNull();
	});

	it("loads stored orchestration_defs into the registry on first build", async () => {
		const db = makeTestDb();
		const registry = makeOrchestratorRegistry([noopKind]);
		const stored: OrchestrationDef = def("stored", [node("a", "noop", ["start"])]);
		await upsertOrchestrationDef(db, stored);
		const { jobs, sent } = fakeJobs();
		const host = makeOrchestrationHost({
			run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
				Effect.runPromise(
					effect.pipe(Effect.provideService(OrchestratorRegistry, registry)) as Effect.Effect<A, E>,
				),
			db,
			jobs,
		});
		// Before the build the registry does not know the stored def.
		expect(registry.has("stored")).toBe(false);
		const runId = await host.startRun("stored");
		expect(registry.has("stored")).toBe(true);
		expect(sent[0]).toMatchObject({
			kind: ORCHESTRATOR_STEP_KIND,
			payload: { runId },
		});
	});

	it("clears the memoized build on failure so the next call retries", async () => {
		const h = harness({
			kinds: [noopKind],
			defs: [def("d", [node("a", "noop", ["start"])])],
			rejectRuns: 1,
		});
		await expect(h.host.runner()).rejects.toThrow("runtime down");
		// Second call rebuilds — the rejection was not memoized.
		const runner = await h.host.runner();
		expect(runner).toBeDefined();
	});

	it("registration handle retries runner construction after a failed build", async () => {
		const h = harness({ kinds: [noopKind], rejectRuns: 1 });
		h.host.registerStepHandler();
		const registration = jobHandlers[ORCHESTRATOR_STEP_KIND];
		// First delivery: runner build rejects → handle rejects (consumer retries).
		await expect(
			registration?.handle(
				{ runId: "ghost" },
				{
					id: "env-0",
					kind: ORCHESTRATOR_STEP_KIND,
					payload: { runId: "ghost" },
				},
			),
		).rejects.toThrow("runtime down");
		// The failed build cleared both memos — a redelivery rebuilds and
		// the (missing) run no-ops cleanly.
		await registration?.handle(
			{ runId: "ghost" },
			{
				id: "env-1",
				kind: ORCHESTRATOR_STEP_KIND,
				payload: { runId: "ghost" },
			},
		);
	});
});
