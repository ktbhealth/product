import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { orchestrationDefs, orchestrationEvents, orchestrationRuns } from "../schema.ts";

import { eq } from "drizzle-orm";

import { makeOrchestratorRegistry } from "../registry.ts";
import type { OrchestrationDef, OrchestrationKind } from "../types.ts";
import { OrchestrationEvent } from "../types.ts";
import {
	createOrchestrationRun,
	getOrchestrationDef,
	getOrchestrationRun,
	listNodeRuns,
	listOrchestrationDefs,
	listOrchestrationRuns,
	listPendingEvents,
	loadOrchestrationRun,
	loadStoredDefs,
	markOrchestrationRunFailed,
	saveOrchestrationStep,
	upsertOrchestrationDef,
} from "./store.ts";
import type { OrchestrationSnapshot } from "../runner.ts";

const makeTestDb = (): DbClient => makeDb(makeTestD1());

const noopKind: OrchestrationKind = { id: "noop", run: () => Effect.succeed({}) };

const sampleDef = (id = "demo", extra?: Partial<OrchestrationDef>): OrchestrationDef => ({
	id,
	version: "2",
	nodes: [{ id: "a", kind: "noop", on: ["start"], emits: [] }],
	...extra,
});

const emptySnapshot = (over?: Partial<OrchestrationSnapshot>): OrchestrationSnapshot => ({
	runtimes: [],
	state: {},
	trace: [],
	tracePersisted: 0,
	events: [],
	status: "done",
	halted: false,
	doneEmitted: false,
	config: {},
	onNodeError: "halt",
	maxEvents: 1000,
	...over,
});

describe("upsertOrchestrationDef / getOrchestrationDef", () => {
	it("round-trips a data-only def", async () => {
		const db = makeTestDb();
		const def = sampleDef();
		await upsertOrchestrationDef(db, def, 1000);
		const got = await getOrchestrationDef(db, "demo");
		expect(got).toMatchObject({
			id: "demo",
			version: "2",
			enabled: true,
			createdAt: 1000,
			updatedAt: 1000,
		});
		expect(got?.def.id).toBe("demo");
		expect(got?.def.nodes[0]?.id).toBe("a");
	});

	it('defaults version to "1" and replaces def+version on conflict', async () => {
		const db = makeTestDb();
		await upsertOrchestrationDef(db, { id: "d", nodes: [] }, 1000);
		let got = await getOrchestrationDef(db, "d");
		expect(got?.version).toBe("1");
		await upsertOrchestrationDef(db, sampleDef("d", { version: "3" }), 2000);
		got = await getOrchestrationDef(db, "d");
		expect(got?.version).toBe("3");
		expect(got?.updatedAt).toBe(2000);
		expect(got?.createdAt).toBe(1000);
	});

	it("rejects defs with inline handlers", async () => {
		const db = makeTestDb();
		const def: OrchestrationDef = {
			id: "bad",
			nodes: [
				{
					id: "a",
					kind: "x",
					handler: { id: "x", run: () => Effect.succeed({}) },
					on: [],
					emits: [],
				},
			],
		};
		await expect(upsertOrchestrationDef(db, def)).rejects.toThrow(/inline node handlers/);
	});

	it("returns null for missing and corrupt defs", async () => {
		const db = makeTestDb();
		expect(await getOrchestrationDef(db, "nope")).toBeNull();
		await db.insert(orchestrationDefs).values({
			id: "corrupt",
			version: "1",
			def: "{not json",
			enabled: true,
			createdAt: 1,
			updatedAt: 1,
		});
		await db.insert(orchestrationDefs).values({
			id: "shapeless",
			version: "1",
			def: "{}",
			enabled: true,
			createdAt: 1,
			updatedAt: 1,
		});
		expect(await getOrchestrationDef(db, "corrupt")).toBeNull();
		expect(await getOrchestrationDef(db, "shapeless")).toBeNull();
	});
});

describe("listOrchestrationDefs / loadStoredDefs", () => {
	it("lists enabled defs by default and all defs on request, skipping corrupt rows", async () => {
		const db = makeTestDb();
		await upsertOrchestrationDef(db, sampleDef("a"));
		await upsertOrchestrationDef(db, sampleDef("b"));
		await db.insert(orchestrationDefs).values({
			id: "off",
			version: "1",
			def: JSON.stringify(sampleDef("off")),
			enabled: false,
			createdAt: 1,
			updatedAt: 1,
		});
		await db.insert(orchestrationDefs).values({
			id: "junk",
			version: "1",
			def: "nope",
			enabled: true,
			createdAt: 1,
			updatedAt: 1,
		});
		expect((await listOrchestrationDefs(db)).map((d) => d.id)).toEqual(["a", "b"]);
		expect((await listOrchestrationDefs(db, { enabledOnly: false })).map((d) => d.id)).toEqual([
			"a",
			"b",
			"off",
		]);
	});

	it("loadStoredDefs registers enabled defs, skips in-memory ones, propagates kind errors", async () => {
		const db = makeTestDb();
		const registry = makeOrchestratorRegistry([noopKind]);
		await upsertOrchestrationDef(db, sampleDef("stored"));
		await upsertOrchestrationDef(db, sampleDef("already"));
		registry.registerDef(sampleDef("already"));
		// A stored def whose kind is not registered fails at boot.
		await upsertOrchestrationDef(db, {
			id: "orphan",
			nodes: [{ id: "x", kind: "missing-kind", on: [], emits: [] }],
		});
		await expect(loadStoredDefs(registry, db)).rejects.toMatchObject({
			_tag: "UnknownKindError",
		});
		// Without the orphan row it loads the gap only.
		const db2 = makeTestDb();
		await upsertOrchestrationDef(db2, sampleDef("stored"));
		await upsertOrchestrationDef(db2, sampleDef("already"));
		const registry2 = makeOrchestratorRegistry([noopKind]);
		registry2.registerDef(sampleDef("already"));
		expect(await loadStoredDefs(registry2, db2)).toBe(1);
		expect(registry2.has("stored")).toBe(true);
		expect(registry2.has("already")).toBe(true);
	});
});

describe("run rows, pending events and node trace", () => {
	const seed = async (db: DbClient) => {
		const snapshot = emptySnapshot({
			state: { n: 1 },
			trace: [{ nodeId: "a", status: "ok", latencyMs: 5, fires: 1 }],
		});
		await createOrchestrationRun(db, {
			id: "run-1",
			defId: "demo",
			defVersion: "2",
			snapshot,
			initialEvent: OrchestrationEvent.new("input", { x: 1 }, "run"),
			now: 100,
		});
		return snapshot;
	};

	it("creates a run with its seed event and reads it back", async () => {
		const db = makeTestDb();
		await seed(db);
		const record = await getOrchestrationRun(db, "run-1");
		expect(record).toMatchObject({
			id: "run-1",
			defId: "demo",
			defVersion: "2",
			status: "running",
			state: { n: 1 },
			error: null,
			createdAt: 100,
		});
		expect(await getOrchestrationRun(db, "missing")).toBeNull();
		const pending = await listPendingEvents(db, "run-1");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.seq).toBe(0);
		expect(pending[0]?.event).toMatchObject({ type: "input", source: "run" });
		expect(pending[0]?.event.payload).toEqual({ x: 1 });
	});

	it("loadOrchestrationRun returns record + snapshot + queue; null/corrupt handling", async () => {
		const db = makeTestDb();
		expect(await loadOrchestrationRun(db, "nope")).toBeNull();
		const snapshot = await seed(db);
		const loaded = await loadOrchestrationRun(db, "run-1");
		expect(loaded?.record.id).toBe("run-1");
		expect(loaded?.runtime?.state).toEqual({ n: 1 });
		expect(loaded?.pending).toHaveLength(1);
		// Corrupt runtime → runtime null (runner fails the run, no retry).
		await db
			.update(orchestrationRuns)
			.set({ runtime: "{broken" })
			.where(eq(orchestrationRuns.id, "run-1"));
		const corrupt = await loadOrchestrationRun(db, "run-1");
		expect(corrupt?.runtime).toBeNull();
		// Corrupt state JSON → record.state falls back to {}.
		await db
			.update(orchestrationRuns)
			.set({ state: "not-json" })
			.where(eq(orchestrationRuns.id, "run-1"));
		const rec = await getOrchestrationRun(db, "run-1");
		expect(rec?.state).toEqual({});
		expect(snapshot.trace).toHaveLength(1);
	});

	it("listOrchestrationRuns filters by defId/status and orders newest first", async () => {
		const db = makeTestDb();
		const mk = async (id: string, defId: string, status: string, at: number) => {
			await db.insert(orchestrationRuns).values({
				id,
				defId,
				defVersion: "1",
				status,
				state: "{}",
				runtime: "{}",
				error: null,
				createdAt: at,
				updatedAt: at,
			});
		};
		await mk("r1", "d1", "done", 10);
		await mk("r2", "d1", "running", 30);
		await mk("r3", "d2", "failed", 20);
		expect((await listOrchestrationRuns(db)).map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
		expect((await listOrchestrationRuns(db, { defId: "d1" })).map((r) => r.id)).toEqual([
			"r2",
			"r1",
		]);
		expect((await listOrchestrationRuns(db, { status: "failed" })).map((r) => r.id)).toEqual([
			"r3",
		]);
		expect(
			(await listOrchestrationRuns(db, { defId: "d1", status: "done", limit: 5 })).map((r) => r.id),
		).toEqual(["r1"]);
		expect(await listOrchestrationRuns(db, { defId: "none" })).toEqual([]);
	});

	it("stamps tenant_id on create and filters runs by tenant scope", async () => {
		const db = makeTestDb();
		const snapshot = emptySnapshot();
		const mk = (id: string, tenantId: number | null) =>
			createOrchestrationRun(db, {
				id,
				defId: "demo",
				defVersion: "1",
				snapshot,
				initialEvent: OrchestrationEvent.start(),
				tenantId,
				now: 100,
			});
		await mk("t-global", null);
		await mk("t-7", 7);
		await mk("t-9", 9);
		// Absent tenantId also lands NULL.
		await createOrchestrationRun(db, {
			id: "t-absent",
			defId: "demo",
			defVersion: "1",
			snapshot,
			initialEvent: OrchestrationEvent.start(),
			now: 100,
		});
		expect((await getOrchestrationRun(db, "t-7"))?.tenantId).toBe(7);
		expect((await getOrchestrationRun(db, "t-global"))?.tenantId).toBeNull();
		expect((await getOrchestrationRun(db, "t-absent"))?.tenantId).toBeNull();
		// jobs-port filter convention: absent = all, null = NULL rows,
		// number = that tenant.
		expect((await listOrchestrationRuns(db)).map((r) => r.id).sort()).toEqual([
			"t-7",
			"t-9",
			"t-absent",
			"t-global",
		]);
		expect((await listOrchestrationRuns(db, { tenantId: null })).map((r) => r.id).sort()).toEqual([
			"t-absent",
			"t-global",
		]);
		expect((await listOrchestrationRuns(db, { tenantId: 7 })).map((r) => r.id)).toEqual(["t-7"]);
		expect(await listOrchestrationRuns(db, { tenantId: 42 })).toEqual([]);
	});

	it("saveOrchestrationStep rewrites the queue, updates the run and appends trace idempotently", async () => {
		const db = makeTestDb();
		await seed(db);
		const snapshot = emptySnapshot({
			state: { n: 2 },
			trace: [
				{ nodeId: "a", status: "ok", latencyMs: 5, fires: 1 },
				{ nodeId: "b", status: "failed", latencyMs: 3, error: "boom", fires: 0 },
			],
			tracePersisted: 1,
		});
		const e1 = OrchestrationEvent.new("e1", {}, "a");
		const e2 = OrchestrationEvent.new("e2", {}, "b");
		await saveOrchestrationStep(db, {
			runId: "run-1",
			queue: [e1, e2],
			snapshot,
			status: "running",
			now: 200,
		});
		const pending = await listPendingEvents(db, "run-1");
		expect(pending.map((p) => p.event.type)).toEqual(["e1", "e2"]);
		const record = await getOrchestrationRun(db, "run-1");
		expect(record?.status).toBe("running");
		expect(record?.state).toEqual({ n: 2 });
		expect(record?.updatedAt).toBe(200);
		// Only the trace tail (index >= tracePersisted) lands.
		const nodeRuns = await listNodeRuns(db, "run-1");
		expect(nodeRuns).toHaveLength(1);
		expect(nodeRuns[0]).toMatchObject({ seq: 1, nodeId: "b", status: "failed", error: "boom" });
		// Replaying the same boundary upserts instead of conflicting.
		await saveOrchestrationStep(db, {
			runId: "run-1",
			queue: [e1, e2],
			snapshot,
			status: "done",
			now: 300,
		});
		expect(await listNodeRuns(db, "run-1")).toHaveLength(1);
		expect((await getOrchestrationRun(db, "run-1"))?.status).toBe("done");
	});

	it("saveOrchestrationStep on a fresh trace writes every record and clears the queue on terminal", async () => {
		const db = makeTestDb();
		await seed(db);
		const snapshot = emptySnapshot({
			trace: [
				{ nodeId: "a", status: "ok", latencyMs: 1, fires: 1 },
				{ nodeId: "a", status: "skipped", latencyMs: 0, fires: 1 },
			],
			error: "budget",
		});
		await saveOrchestrationStep(db, {
			runId: "run-1",
			queue: [],
			snapshot,
			status: "failed",
		});
		expect(await listPendingEvents(db, "run-1")).toEqual([]);
		const nodeRuns = await listNodeRuns(db, "run-1");
		expect(nodeRuns.map((r) => r.status)).toEqual(["ok", "skipped"]);
		const record = await getOrchestrationRun(db, "run-1");
		expect(record?.status).toBe("failed");
		expect(record?.error).toBe("budget");
	});

	it("tolerates events with a missing payload when writing the queue", async () => {
		const db = makeTestDb();
		await seed(db);
		const snapshot = emptySnapshot();
		const bare = {
			type: "bare",
			payload: undefined,
			source: "a",
			id: "evt-bare",
			ts: 1,
		} as unknown as OrchestrationEvent;
		await saveOrchestrationStep(db, {
			runId: "run-1",
			queue: [bare],
			snapshot,
			status: "running",
		});
		const pending = await listPendingEvents(db, "run-1");
		expect(pending[0]?.event.payload).toEqual({});
	});

	it("markOrchestrationRunFailed fails the run and drops pending events", async () => {
		const db = makeTestDb();
		await seed(db);
		await markOrchestrationRunFailed(db, "run-1", "kaput", 400);
		const record = await getOrchestrationRun(db, "run-1");
		expect(record?.status).toBe("failed");
		expect(record?.error).toBe("kaput");
		expect(await listPendingEvents(db, "run-1")).toEqual([]);
	});

	it("reconstructs pending events with corrupt payloads as empty objects", async () => {
		const db = makeTestDb();
		await seed(db);
		await db.insert(orchestrationEvents).values({
			runId: "run-1",
			seq: 1,
			eventId: "evt-x",
			eventType: "weird",
			payload: "{broken",
			source: "a",
			ts: 5,
		});
		await db.insert(orchestrationEvents).values({
			runId: "run-1",
			seq: 2,
			eventId: "evt-y",
			eventType: "array",
			payload: "[1,2]",
			source: "a",
			ts: 6,
		});
		await db.insert(orchestrationEvents).values({
			runId: "run-1",
			seq: 3,
			eventId: "evt-z",
			eventType: "scalar",
			payload: "42",
			source: "a",
			ts: 7,
		});
		const pending = await listPendingEvents(db, "run-1");
		expect(pending[1]?.event).toMatchObject({
			type: "weird",
			payload: {},
			source: "a",
			id: "evt-x",
			ts: 5,
		});
		expect(pending[2]?.event.payload).toEqual({});
		expect(pending[3]?.event.payload).toEqual({});
	});
});
