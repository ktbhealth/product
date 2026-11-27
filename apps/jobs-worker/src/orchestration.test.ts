import { describe, expect, it } from "vitest";

import { makeDb, type DbClient, type SqlDatabase } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import type { JobEnvelope, JobsEnqueuer } from "@ktb/jobs-port";
import { makeJobHandlerRegistry } from "@ktb/jobs-port";
import {
	ORCHESTRATOR_STEP_KIND,
	getOrchestrationRun,
	upsertOrchestrationDef,
	type OrchestrationDef,
	type OrchestrationNode,
} from "@ktb/orchestrator";

import { openWorkerDb } from "./db.ts";
import { makeOrchestrationWorker } from "./orchestration.ts";

/** Real migrated sqlite (:memory:) — the same store main.ts opens. */
const makeTestDb = (): DbClient => {
	const db = openWorkerDb({ DATABASE_URL: ":memory:" });
	if (db === undefined) throw new Error("test db failed to open");
	return db;
};

/** Capturing enqueuer — same fake-transport shape the orchestrator
 * package's own runner tests and apps/web's orchestration test use. */
const fakeJobs = () => {
	const sent: { kind: string; payload: unknown }[] = [];
	const jobs: JobsEnqueuer = {
		enqueue: async (kind, payload): Promise<JobEnvelope> => {
			sent.push({ kind, payload });
			return { id: `job-${sent.length}`, kind, payload };
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

/** Stored defs only resolve builtin kinds in the worker (no plugin
 * packs) — `emit` with no `params.events` fires once and emits
 * nothing, so the run drains and finishes. */
const emitDef = (id: string): OrchestrationDef => def(id, [node("a", "emit", ["start"])]);

const stepEnvelope = (payload: unknown): JobEnvelope => ({
	id: "env-0",
	kind: ORCHESTRATOR_STEP_KIND,
	payload,
	tenantId: null,
});

describe("makeOrchestrationWorker", () => {
	it("registers orchestrator.step: decodes {runId}, is idempotent, and a ghost run no-ops", async () => {
		const db = makeTestDb();
		const { jobs } = fakeJobs();
		const worker = makeOrchestrationWorker({ db, jobs });
		const registry = makeJobHandlerRegistry();
		worker.registerStepHandler(registry);
		worker.registerStepHandler(registry);

		const registration = registry.lookup(ORCHESTRATOR_STEP_KIND);
		expect(registration).toBeDefined();
		expect(registration?.idempotent).toBe(true);
		expect(registration?.decodePayload?.({ runId: "r1" })).toEqual({ runId: "r1" });
		expect(() => registration?.decodePayload?.({ nope: 1 })).toThrow(/runId/);

		// First delivery builds the runner lazily (stored-def load
		// included); a missing run is an idempotent no-op.
		await registration?.handle({ runId: "ghost" }, stepEnvelope({ runId: "ghost" }));
	});

	it("loads stored defs and drives a builtin-kind run to done through the step job", async () => {
		const db = makeTestDb();
		await upsertOrchestrationDef(db, emitDef("stored-emit"));
		const { jobs, sent } = fakeJobs();
		const worker = makeOrchestrationWorker({ db, jobs });
		const registry = makeJobHandlerRegistry();
		worker.registerStepHandler(registry);

		const runId = await worker.startRun("stored-emit");
		expect(runId).toMatch(/^orun-/);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			kind: ORCHESTRATOR_STEP_KIND,
			payload: { runId },
		});

		const registration = registry.lookup(ORCHESTRATOR_STEP_KIND);
		const payload = registration?.decodePayload?.(sent[0]?.payload);
		await registration?.handle(payload, stepEnvelope(sent[0]?.payload));
		expect((await getOrchestrationRun(db, runId))?.status).toBe("done");
	});

	it("provides OrchestratorRegistry in ambientContext so subworkflow resolves", async () => {
		const db = makeTestDb();
		await upsertOrchestrationDef(db, emitDef("child"));
		await upsertOrchestrationDef(
			db,
			def("parent", [
				node("sub", "subworkflow", ["start"], {
					params: { defId: "child" },
				}),
			]),
		);
		const { jobs, sent } = fakeJobs();
		const worker = makeOrchestrationWorker({ db, jobs });
		const registry = makeJobHandlerRegistry();
		worker.registerStepHandler(registry);

		const runId = await worker.startRun("parent");
		const registration = registry.lookup(ORCHESTRATOR_STEP_KIND);
		const payload = registration?.decodePayload?.(sent[0]?.payload);
		await registration?.handle(payload, stepEnvelope(sent[0]?.payload));

		const record = await getOrchestrationRun(db, runId);
		expect(record?.status).toBe("done");
		// The subworkflow node's output lands at state[nodeId]; a
		// resolved registry yields {defId, status: "done", …} — absent
		// ambientContext it would be {skipped: true, reason: "no-registry"}.
		const sub = record?.state["sub"] as { status?: string; skipped?: boolean } | undefined;
		expect(sub?.skipped).not.toBe(true);
		expect(sub?.status).toBe("done");
	});

	it("clears the memoized build on failure so the next call retries", async () => {
		// A SqlDatabase whose first prepare() throws simulates a
		// transient db failure during loadStoredDefs; the memo must
		// clear so the retry rebuilds against the healthy db.
		const base = makeTestD1();
		let failPrepare = true;
		const flaky: SqlDatabase = {
			...base,
			prepare: (query: string) => {
				if (failPrepare) {
					failPrepare = false;
					throw new Error("db down");
				}
				return base.prepare(query);
			},
		};
		const db = makeDb(flaky);
		const { jobs } = fakeJobs();
		const worker = makeOrchestrationWorker({ db, jobs });

		await expect(worker.runner()).rejects.toThrow("db down");
		// The failed build was not memoized — the next call retries and
		// succeeds once prepare() stops throwing.
		const runner = await worker.runner();
		expect(runner).toBeDefined();
	});
});
