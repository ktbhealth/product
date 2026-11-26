import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import { Db, makeDb } from "@ktb/db";
import { orchestrationNodeRuns, orchestrationRuns } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import {
	makeOrchestratorRegistry,
	OrchestratorRegistry,
	type OrchestrationKind,
} from "@ktb/orchestrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";

import {
	getOrchestrationFn,
	getOrchestrationRunFn,
	listOrchestrationKindsFn,
	listOrchestrationsFn,
	startOrchestrationFn,
	upsertOrchestrationFn,
} from "./fns.ts";

const DDL = `
CREATE TABLE orchestration_defs (
	id TEXT PRIMARY KEY NOT NULL,
	version TEXT NOT NULL,
	def TEXT NOT NULL,
	enabled INTEGER DEFAULT true NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE orchestration_runs (
	id TEXT PRIMARY KEY NOT NULL,
	def_id TEXT NOT NULL,
	def_version TEXT NOT NULL,
	status TEXT DEFAULT 'running' NOT NULL,
	state TEXT NOT NULL,
	runtime TEXT NOT NULL,
	error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE orchestration_node_runs (
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	node_id TEXT NOT NULL,
	status TEXT NOT NULL,
	latency_ms INTEGER NOT NULL,
	error TEXT,
	fires INTEGER NOT NULL,
	PRIMARY KEY(run_id, seq)
);
`;

const demoDef = {
	id: "demo",
	version: "1",
	description: "demo def",
	nodes: [
		{ id: "a", kind: "emit", on: ["start"], emits: ["go"] },
		{ id: "b", kind: "gate", on: ["go"], emits: ["gate.pass"] },
	],
};

describe("pipeline admin fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));

	beforeAll(async () => {
		const db = makeDb(makeD1(DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(env as Layer.Layer<unknown, never, never>);
		installServerFnRuntime(runtime, auth);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		expect(await listOrchestrationsFn()).toBeNull();
		expect(await getOrchestrationFn({ data: "demo" })).toBeNull();
		expect(await listOrchestrationKindsFn()).toBeNull();
		await expect(upsertOrchestrationFn({ data: demoDef })).rejects.toThrow("unauthenticated");
	});

	it("denies non-admin principals", async () => {
		currentEmail = "user@x.com";
		expect(await listOrchestrationsFn()).toBeNull();
		expect(await getOrchestrationFn({ data: "demo" })).toBeNull();
		expect(await listOrchestrationKindsFn()).toBeNull();
		await expect(upsertOrchestrationFn({ data: demoDef })).resolves.toBe(false);
	});

	it("lists, upserts and reads defs as admin", async () => {
		currentEmail = "admin@x.com";
		expect(await listOrchestrationsFn()).toEqual([]);

		const saved = await upsertOrchestrationFn({ data: demoDef });
		expect(saved).not.toBe(false);
		expect(saved && typeof saved === "object" ? saved.id : null).toBe("demo");

		const rows = await listOrchestrationsFn();
		expect(rows).toHaveLength(1);
		expect(rows?.[0]).toMatchObject({
			id: "demo",
			version: "1",
			description: "demo def",
			nodeCount: 2,
			enabled: true,
		});

		const record = await getOrchestrationFn({ data: "demo" });
		expect(record?.def.nodes).toHaveLength(2);
		expect(record?.def.nodes[0]?.emits).toEqual(["go"]);
		expect(await getOrchestrationFn({ data: "nope" })).toBeNull();
	});

	it("re-upserts replace the stored def", async () => {
		currentEmail = "admin@x.com";
		const updated = {
			...demoDef,
			version: "2",
			nodes: [{ id: "solo", kind: "emit", on: [], emits: [] }],
		};
		await upsertOrchestrationFn({ data: updated });
		const rows = await listOrchestrationsFn();
		expect(rows?.[0]).toMatchObject({ id: "demo", version: "2", nodeCount: 1 });
	});

	it("rejects malformed defs at the validator", async () => {
		currentEmail = "admin@x.com";
		await expect(
			upsertOrchestrationFn({ data: { id: "x", nodes: "nope" } } as never),
		).rejects.toThrow(/\S/);
		await expect(
			upsertOrchestrationFn({
				data: {
					id: "x",
					nodes: [
						{ id: "a", kind: "emit", on: [], emits: [] },
						{ id: "a", kind: "emit", on: [], emits: [] },
					],
				},
			}),
		).rejects.toThrow(/duplicate node id/);
	});

	it("falls back to builtin kinds when no registry is provided", async () => {
		currentEmail = "admin@x.com";
		const kinds = await listOrchestrationKindsFn();
		// builtinKinds grows as the engine ships kinds — assert the
		// shipped floor and the sorted/deduped contract, not the exact set.
		expect(kinds).toEqual(expect.arrayContaining(["ai", "emit", "gate"]));
		expect([...new Set(kinds ?? [])].sort()).toEqual([...(kinds ?? [])]);
	});
});

describe("listOrchestrationKindsFn with a live registry", () => {
	it("lists registered kinds plus builtins when the registry is provided", async () => {
		const custom: OrchestrationKind = {
			id: "stage.custom",
			run: () => Effect.succeed({}),
		};
		const db = makeDb(makeD1(DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				env,
				Layer.succeed(OrchestratorRegistry, makeOrchestratorRegistry([custom])),
			) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(
			rt,
			stubAuth(() => sessionUser("admin@x.com")),
		);
		try {
			// The registry carries only the seeded kinds — builtinKinds is
			// the fallback only when NO registry service exists.
			expect(await listOrchestrationKindsFn()).toEqual(["stage.custom"]);
		} finally {
			resetServerFnRuntime();
			await rt.dispose();
		}
	});
});

describe("durable-run fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let testDb: ReturnType<typeof makeDb>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));
	const startRun = vi.fn<(defId: string, input?: unknown) => Promise<string>>(
		async (defId, input) => {
			void input;
			return `orun-${defId}`;
		},
	);

	beforeAll(async () => {
		testDb = makeDb(makeD1(DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, testDb),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(env as Layer.Layer<unknown, never, never>);
		installServerFnRuntime(runtime, auth, {
			orchestration: { startRun },
		});
		// Fixture run + trace row for getOrchestrationRunFn.
		await testDb.insert(orchestrationRuns).values({
			id: "orun-demo",
			defId: "demo",
			defVersion: "1",
			status: "done",
			state: JSON.stringify({ seen: "pong" }),
			runtime: "{}",
			error: null,
			createdAt: 1,
			updatedAt: 2,
		});
		await testDb.insert(orchestrationNodeRuns).values({
			runId: "orun-demo",
			seq: 0,
			nodeId: "a",
			status: "ok",
			latencyMs: 5,
			error: null,
			fires: 1,
		});
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(startOrchestrationFn({ data: { defId: "demo" } })).rejects.toThrow(
			"unauthenticated",
		);
		expect(await getOrchestrationRunFn({ data: "orun-demo" })).toBeNull();
	});

	it("denies non-admin principals", async () => {
		currentEmail = "user@x.com";
		expect(await startOrchestrationFn({ data: { defId: "demo" } })).toBe(false);
		expect(await getOrchestrationRunFn({ data: "orun-demo" })).toBeNull();
	});

	it("starts a run through the orchestration capability", async () => {
		currentEmail = "admin@x.com";
		startRun.mockClear();
		const result = await startOrchestrationFn({ data: { defId: "demo", input: { x: 1 } } });
		expect(result).toEqual({ ok: true, runId: "orun-demo" });
		expect(startRun).toHaveBeenCalledWith("demo", { x: 1 });
	});

	it("reports runner failures as {ok:false} with the error text", async () => {
		currentEmail = "admin@x.com";
		startRun.mockRejectedValueOnce(new Error("unknown orchestration: ghost"));
		expect(await startOrchestrationFn({ data: { defId: "ghost" } })).toEqual({
			ok: false,
			error: "unknown orchestration: ghost",
		});
		// Non-Error rejections degrade to String(error).
		startRun.mockRejectedValueOnce("plain boom");
		expect(await startOrchestrationFn({ data: { defId: "ghost" } })).toEqual({
			ok: false,
			error: "plain boom",
		});
		// Error with an empty message falls back to String(error).
		startRun.mockRejectedValueOnce(new Error(""));
		expect(await startOrchestrationFn({ data: { defId: "ghost" } })).toEqual({
			ok: false,
			error: "Error",
		});
	});

	it("reads a run record with its node trace", async () => {
		currentEmail = "admin@x.com";
		const run = await getOrchestrationRunFn({ data: "orun-demo" });
		expect(run).toMatchObject({
			id: "orun-demo",
			defId: "demo",
			status: "done",
			state: { seen: "pong" },
		});
		expect(run?.nodeRuns).toEqual([
			{ seq: 0, nodeId: "a", status: "ok", latencyMs: 5, error: null, fires: 1 },
		]);
		expect(await getOrchestrationRunFn({ data: "orun-missing" })).toBeNull();
	});
});

describe("startOrchestrationFn without the capability", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;

	beforeAll(() => {
		const db = makeDb(makeD1(DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(env as Layer.Layer<unknown, never, never>);
		installServerFnRuntime(
			runtime,
			stubAuth(() => sessionUser(currentEmail)),
		);
		currentEmail = "admin@x.com";
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("reports unavailable when the jobs transport is unbound", async () => {
		expect(await startOrchestrationFn({ data: { defId: "demo" } })).toEqual({
			ok: false,
			error: "orchestration runner unavailable (jobs transport unbound)",
		});
	});
});
