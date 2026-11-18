import { beforeEach, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const mocks = vi.hoisted(() => ({
	getSessionUser: vi.fn(),
	ensureSessionUser: vi.fn(),
	runAs: vi.fn(),
}));

// Same fake as the sibling plugin fns tests: handlers run as plain
// async fns; `runAs` executes the Effect for real against a runtime
// wired with the test Db so the service/d denial branches are hit.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const api = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return api;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (call?: { data?: unknown }) =>
				h({ ...(call ?? {}), data: validate ? validate(call?.data) : call?.data }),
		};
		return api;
	},
}));
vi.mock("@ktb/server-fns", () => ({
	getSessionUser: mocks.getSessionUser,
	ensureSessionUser: mocks.ensureSessionUser,
	runAs: mocks.runAs,
}));

import { Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { groups } from "@ktb/db/schema";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Tenant } from "@ktb/tenant";

import { MACHINES_TEST_DDL, Machines, MachinesLive, machine, type MachineCard } from "./index.ts";
import {
	machinesBeatFn,
	machinesCheckAllFn,
	machinesCheckFn,
	machinesCreateFn,
	machinesListFn,
	machinesRemoveFn,
	machinesUpdateFn,
} from "./fns.ts";

const ADMIN_EMAIL = "admin@x.com";
const MEMBER_EMAIL = "doc@clinic.com";

const makeRuntime = (db: DbClient) => {
	const infra = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(ADMIN_EMAIL))),
	);
	return ManagedRuntime.make(MachinesLive.pipe(Layer.provide(infra)));
};

describe("machines fns", () => {
	let db: DbClient;
	let runtime: ManagedRuntime.ManagedRuntime<Machines, never>;

	beforeEach(async () => {
		vi.clearAllMocks();
		db = makeDb(makeD1(MACHINES_TEST_DDL));
		runtime = makeRuntime(db);
		mocks.getSessionUser.mockResolvedValue({ id: "u1", email: ADMIN_EMAIL });
		mocks.ensureSessionUser.mockResolvedValue({ id: "u1", email: ADMIN_EMAIL });
		mocks.runAs.mockImplementation(
			async (
				user: { id: string; email: string },
				effect: Effect.Effect<unknown, unknown, unknown>,
			) =>
				runtime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, { userId: user.id, email: user.email }),
						Effect.provideService(Tenant, {
							id: 7,
							kind: "clinic",
							slug: "clinic-7",
							role: "admin",
						}),
					) as Effect.Effect<unknown, unknown, never>,
				),
		);
	});

	it("machinesListFn returns [] for anonymous callers", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		await expect(machinesListFn()).resolves.toEqual([]);
		expect(mocks.runAs).not.toHaveBeenCalled();
	});

	it("machinesListFn lists platform machines for admins", async () => {
		await machinesCreateFn({ data: { name: "fn-box", host: "fn.local" } });
		const rows = (await machinesListFn()) as readonly MachineCard[];
		expect(rows.map((r) => r.name)).toContain("fn-box");
	});

	it("machinesListFn degrades to [] on denial", async () => {
		mocks.getSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		await expect(machinesListFn()).resolves.toEqual([]);
	});

	it("machinesCreateFn returns the card and applies defaults", async () => {
		const result = (await machinesCreateFn({
			data: {
				name: "created",
				kind: "gpu",
				host: "h",
				port: 2200,
				capabilities: ["acp"],
				secretRef: "vault:4",
				healthUrl: "http://h/health",
			},
		})) as { ok: true; data: MachineCard };
		expect(result.ok).toBe(true);
		expect(result.data.name).toBe("created");
		expect(result.data.scope).toBe("platform");
		expect(result.data.kind).toBe("gpu");
		expect(result.data.capabilities).toEqual(["acp"]);
		expect(result.data.secretRef).toBe("vault:4");
		expect(result.data.healthUrl).toBe("http://h/health");
	});

	it("machinesCreateFn maps MachineError denials to { ok: false }", async () => {
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		const result = await machinesCreateFn({ data: { name: "x", host: "h" } });
		expect(result).toEqual({ ok: false });
	});

	it("validators reject malformed payloads", async () => {
		await expect(machinesCreateFn({ data: { name: "", host: "h" } })).rejects.toThrow();
		await expect(machinesUpdateFn({ data: { id: "nope" } })).rejects.toThrow();
		await expect(machinesCheckFn({ data: {} })).rejects.toThrow();
		await expect(machinesRemoveFn({ data: { id: "x" } })).rejects.toThrow();
		await expect(machinesBeatFn({ data: {} })).rejects.toThrow();
	});

	it("update/check/remove/beat round-trip through the service", async () => {
		const created = (await machinesCreateFn({
			data: { name: "round", host: "round.local", healthUrl: "http://round.local/h" },
		})) as { ok: true; data: MachineCard };
		const id = created.data.id;

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok")),
		);
		try {
			const updated = (await machinesUpdateFn({
				data: {
					id,
					name: "round-2",
					kind: "vm",
					host: "round2.local",
					port: 2201,
					capabilities: ["tts"],
					secretRef: "env:TOKEN",
					healthUrl: "http://round2.local/h",
					enabled: false,
				},
			})) as { ok: true; data: MachineCard };
			expect(updated.data.name).toBe("round-2");
			expect(updated.data.enabled).toBe(false);

			// Sparse update — every optional field absent.
			const sparse = (await machinesUpdateFn({ data: { id, enabled: true } })) as {
				ok: true;
				data: MachineCard;
			};
			expect(sparse.data.enabled).toBe(true);

			const checked = (await machinesCheckFn({ data: { id } })) as {
				ok: true;
				data: MachineCard | null;
			};
			expect(checked.ok).toBe(true);

			const beat = (await machinesBeatFn({ data: { id } })) as { ok: true; data: null };
			expect(beat).toEqual({ ok: true, data: null });

			const removed = (await machinesRemoveFn({ data: { id } })) as {
				ok: true;
				data: null;
			};
			expect(removed).toEqual({ ok: true, data: null });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("check on a missing id and checkAll both degrade cleanly", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok")),
		);
		try {
			const missing = await machinesCheckFn({ data: { id: 999_999 } });
			expect(missing).toEqual({ ok: false });
			const all = (await machinesCheckAllFn()) as {
				ok: true;
				data: readonly MachineCard[];
			};
			expect(all.ok).toBe(true);
			expect(Array.isArray(all.data)).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("tenant-scope denials collapse via TenantForbidden", async () => {
		await db.insert(groups).values({
			id: 7,
			name: "Clinic",
			slug: "clinic-7",
			kind: "clinic",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const [row] = await db
			.insert(machine)
			.values({
				scope: "7",
				tenantId: 7,
				name: "tenant-box",
				host: "t.local",
				createdAt: new Date(),
			})
			.returning();
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		// Bound tenant with member rank → write requires admin → TenantForbidden.
		mocks.runAs.mockImplementationOnce(
			async (
				user: { id: string; email: string },
				effect: Effect.Effect<unknown, unknown, unknown>,
			) =>
				runtime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
						Effect.provideService(Tenant, {
							id: 7,
							kind: "clinic",
							slug: "clinic-7",
							role: "member",
						}),
					) as Effect.Effect<unknown, unknown, never>,
				),
		);
		expect(await machinesUpdateFn({ data: { id: row!.id, name: "x" } })).toEqual({
			ok: false,
		});
	});

	it("denied mutations return { ok: false }", async () => {
		mocks.ensureSessionUser.mockResolvedValue({ id: "u2", email: MEMBER_EMAIL });
		expect(await machinesUpdateFn({ data: { id: 1, name: "x" } })).toEqual({ ok: false });
		expect(await machinesRemoveFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await machinesCheckFn({ data: { id: 1 } })).toEqual({ ok: false });
		expect(await machinesCheckAllFn()).toEqual({ ok: false });
		expect(await machinesBeatFn({ data: { id: 1 } })).toEqual({ ok: false });
	});
});
