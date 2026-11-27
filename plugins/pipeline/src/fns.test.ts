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

// getOrchestrationDef is spied so the upsert fn's post-write re-read
// can be forced to `null` (the `?? false` wire arm); every other export
// delegates to the real module.
const orchestratorSpy = vi.hoisted(() => ({
	getOrchestrationDef: vi.fn(),
	actual: undefined as unknown,
}));
vi.mock("@ktb/orchestrator", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/orchestrator")>();
	orchestratorSpy.actual = actual.getOrchestrationDef;
	return {
		...actual,
		getOrchestrationDef: (...args: Parameters<typeof actual.getOrchestrationDef>) =>
			orchestratorSpy.getOrchestrationDef(...args),
	};
});

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { orchestrationNodeRuns, orchestrationRuns } from "@ktb/db/schema";

import {
	makeOrchestratorRegistry,
	OrchestratorRegistry,
	type OrchestrationKind,
} from "@ktb/orchestrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	type PlatformAdminShape,
} from "@ktb/platform";
import { Tenant } from "@ktb/tenant";

import {
	getOrchestrationFn,
	getOrchestrationRunFn,
	listOrchestrationKindsFn,
	listOrchestrationsFn,
	orchestrationListRow,
	startOrchestrationFn,
	upsertOrchestrationFn,
} from "./fns.ts";

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
		orchestratorSpy.getOrchestrationDef.mockImplementation(
			orchestratorSpy.actual as typeof orchestratorSpy.getOrchestrationDef,
		);
		const db = makeDb(makeTestD1());
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
		const db = makeDb(makeTestD1());
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
	const startRun = vi.fn<
		(defId: string, input?: unknown, tenantId?: number | null) => Promise<string>
	>(async (defId, input) => {
		void input;
		return `orun-${defId}`;
	});

	beforeAll(async () => {
		testDb = makeDb(makeTestD1());
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
		// No tenant selector bound in tests → personal scope (null).
		expect(startRun).toHaveBeenCalledWith("demo", { x: 1 }, null);
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
			tenantId: null,
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
		const db = makeDb(makeTestD1());
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

describe("orchestrationListRow", () => {
	it("omits description when the def declares none", () => {
		const record = {
			id: "bare",
			version: "3",
			def: { id: "bare", nodes: [] },
			enabled: false,
			createdAt: 1,
			updatedAt: 2,
		} as Parameters<typeof orchestrationListRow>[0];
		expect(orchestrationListRow(record)).toEqual({
			id: "bare",
			version: "3",
			nodeCount: 0,
			enabled: false,
			createdAt: 1,
			updatedAt: 2,
		});
	});
});

describe("non-Forbidden failures propagate", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));

	beforeAll(() => {
		currentEmail = "admin@x.com";
		const db = makeDb(makeTestD1());
		const brokenGate = {
			isAdmin: () => Effect.succeed(false),
			requireAdmin: () => Effect.fail(new Error("gate exploded")),
		} as unknown as PlatformAdminShape;
		const env = Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, brokenGate));
		runtime = ManagedRuntime.make(env as Layer.Layer<unknown, never, never>);
		installServerFnRuntime(runtime, auth);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rethrows non-Forbidden errors from every gated fn", async () => {
		await expect(listOrchestrationsFn()).rejects.toThrow("gate exploded");
		await expect(getOrchestrationFn({ data: "demo" })).rejects.toThrow("gate exploded");
		await expect(upsertOrchestrationFn({ data: demoDef })).rejects.toThrow("gate exploded");
		await expect(listOrchestrationKindsFn()).rejects.toThrow("gate exploded");
		await expect(startOrchestrationFn({ data: { defId: "demo" } })).rejects.toThrow(
			"gate exploded",
		);
		await expect(getOrchestrationRunFn({ data: "orun-demo" })).rejects.toThrow("gate exploded");
	});
});

describe("upsert post-write re-read miss", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));

	beforeAll(() => {
		currentEmail = "admin@x.com";
		orchestratorSpy.getOrchestrationDef.mockImplementation(
			orchestratorSpy.actual as typeof orchestratorSpy.getOrchestrationDef,
		);
		const db = makeDb(makeTestD1());
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(env as Layer.Layer<unknown, never, never>);
		installServerFnRuntime(runtime, auth);
	});

	afterAll(() => {
		resetServerFnRuntime();
		orchestratorSpy.getOrchestrationDef.mockImplementation(
			orchestratorSpy.actual as typeof orchestratorSpy.getOrchestrationDef,
		);
		return runtime.dispose();
	});

	it("reports false when the stored record cannot be re-read", async () => {
		orchestratorSpy.getOrchestrationDef.mockResolvedValueOnce(null);
		expect(await upsertOrchestrationFn({ data: demoDef })).toBe(false);
	});
});

describe("startOrchestrationFn tenant stamping", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	const startRun = vi.fn<
		(defId: string, input?: unknown, tenantId?: number | null) => Promise<string>
	>(async () => "orun-t");

	beforeAll(() => {
		const db = makeDb(makeTestD1());
		// Stub gate: requireAdmin passes without a Principal so the
		// custom runAs only has to bind Tenant (the real gate's
		// Principal path is covered by the describes above).
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, {
				isAdmin: () => Effect.succeed(true),
				requireAdmin: () => Effect.void,
			}),
		);
		runtime = ManagedRuntime.make(env as Layer.Layer<unknown, never, never>);
		installServerFnRuntime(
			runtime,
			stubAuth(() => sessionUser("admin@x.com")),
			{
				orchestration: { startRun },
				// Mirrors the composition root's runAs tenant binding: the
				// resolved Tenant is provided into the request scope.
				runAs: <A, E>(
					_user: { readonly id: string; readonly email?: string },
					effect: Effect.Effect<A, E, unknown>,
				) =>
					runtime.runPromise(
						effect.pipe(
							Effect.provideService(Tenant, {
								id: 7,
								kind: "clinic",
								slug: "clinic-7",
								role: "admin",
							}),
						),
					),
			},
		);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("stamps the bound tenant's id on startRun", async () => {
		startRun.mockClear();
		const result = await startOrchestrationFn({ data: { defId: "demo" } });
		expect(result).toEqual({ ok: true, runId: "orun-t" });
		expect(startRun).toHaveBeenCalledWith("demo", undefined, 7);
	});
});
