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
	listOrchestrationKindsFn,
	listOrchestrationsFn,
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
