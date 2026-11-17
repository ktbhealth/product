import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";

import { KV_TEST_DDL, kvEntries } from "./index.ts";
import { KvAdmin, KvAdminLive, MAX_ADMIN_LIMIT, type KvAdminShape } from "./admin.ts";
import { KvConflictError, KvNotFoundError, KvValidationError } from "./service.ts";

let db: DbClient;
let runtime: ManagedRuntime.ManagedRuntime<KvAdmin, never>;

const ADMIN = { userId: "a1", email: "admin@x.com" };
const USER = { userId: "u1", email: "doc@x.com" };

beforeAll(() => {
	db = makeDb(makeD1(KV_TEST_DDL));
	const env = Layer.mergeAll(
		Layer.succeed(Db, db),
		Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
	);
	runtime = ManagedRuntime.make(Layer.provide(KvAdminLive, env));
});

/** Run an admin-service effect as a given principal (or anonymous). */
const run = <A, E>(
	principal: { userId: string; email?: string } | null,
	effect: (admin: KvAdminShape) => Effect.Effect<A, E>,
) =>
	runtime.runPromise(
		Effect.gen(function* () {
			const admin = yield* KvAdmin;
			return yield* effect(admin);
		}).pipe(Effect.provideService(Principal, principal)),
	);

const runErr = <A, E>(
	principal: { userId: string; email?: string } | null,
	effect: (admin: KvAdminShape) => Effect.Effect<A, E>,
) => run(principal, (admin) => Effect.flip(effect(admin)));

const asAdmin = <A, E>(effect: (admin: KvAdminShape) => Effect.Effect<A, E>) => run(ADMIN, effect);

const seed = (over: Partial<typeof kvEntries.$inferInsert> = {}) =>
	db.insert(kvEntries).values({
		namespace: "alpha",
		key: "k1",
		value: "1",
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	});

describe("KvAdmin gating", () => {
	it("denies non-admin and anonymous principals on every method", async () => {
		for (const principal of [USER, null]) {
			await expect(runErr(principal, (a) => a.list())).resolves.toMatchObject({
				_tag: "Forbidden",
			});
			await expect(runErr(principal, (a) => a.namespaces())).resolves.toMatchObject({
				_tag: "Forbidden",
			});
			await expect(
				runErr(principal, (a) => a.get({ namespace: "alpha", key: "k1" })),
			).resolves.toMatchObject({ _tag: "Forbidden" });
			await expect(
				runErr(principal, (a) => a.set({ namespace: "alpha", key: "k1", value: 1 })),
			).resolves.toMatchObject({ _tag: "Forbidden" });
			await expect(
				runErr(principal, (a) => a.remove({ namespace: "alpha", key: "k1" })),
			).resolves.toMatchObject({ _tag: "Forbidden" });
		}
	});
});

describe("KvAdmin.list", () => {
	it("lists entries across namespaces and scopes with decoded values", async () => {
		await seed({ namespace: "alpha", key: "a1", value: '{"x":1}', tenantId: 3 });
		await seed({ namespace: "beta", key: "b1", value: '"s"', ownerId: "u9" });
		await seed({ namespace: "beta", key: "b2", value: "true" });
		const out = await asAdmin((a) => a.list());
		expect(out.total).toBeGreaterThanOrEqual(3);
		const keys = out.items.map((i) => `${i.namespace}/${i.key}`);
		const a1 = out.items.find((i) => i.key === "a1");
		expect(a1).toMatchObject({
			namespace: "alpha",
			key: "a1",
			tenantId: 3,
			ownerId: null,
			version: 1,
			expired: false,
		});
		expect(a1?.value).toEqual({ x: 1 });
		const b1 = out.items.find((i) => i.key === "b1");
		expect(b1?.value).toBe("s");
		expect(b1?.ownerId).toBe("u9");
		expect(keys).toContain("beta/b2");
	});

	it("filters by namespace and key prefix", async () => {
		const alpha = await asAdmin((a) => a.list({ namespace: "alpha" }));
		expect(alpha.items.every((i) => i.namespace === "alpha")).toBe(true);
		expect(alpha.total).toBe(alpha.items.length);
		const prefixed = await asAdmin((a) => a.list({ prefix: "a" }));
		expect(prefixed.items.every((i) => i.key.startsWith("a"))).toBe(true);
		const empty = await asAdmin((a) => a.list({ namespace: "", prefix: "" }));
		expect(empty.total).toBeGreaterThanOrEqual(1);
	});

	it("paginates with limit and offset, clamping the page size", async () => {
		for (let i = 0; i < 5; i++) {
			await seed({ namespace: "paged", key: `p${i}`, value: "0" });
		}
		const page1 = await asAdmin((a) => a.list({ namespace: "paged", limit: 2 }));
		expect(page1.items).toHaveLength(2);
		expect(page1.total).toBe(5);
		const page3 = await asAdmin((a) => a.list({ namespace: "paged", limit: 2, offset: 4 }));
		expect(page3.items).toHaveLength(1);
		expect(page3.items[0]?.key).toBe("p4");
		const huge = await asAdmin((a) => a.list({ namespace: "paged", limit: 9999 }));
		expect(huge.items.length).toBeLessThanOrEqual(MAX_ADMIN_LIMIT);
		expect(huge.items).toHaveLength(5);
	});

	it("flags expired rows instead of hiding them", async () => {
		await seed({
			namespace: "ttl",
			key: "dead",
			value: "1",
			expiresAt: Date.now() - 1000,
		});
		const out = await asAdmin((a) => a.list({ namespace: "ttl" }));
		const dead = out.items.find((i) => i.key === "dead");
		expect(dead?.expired).toBe(true);
		expect(dead?.expiresAt).not.toBeNull();
	});

	it("returns the raw string for corrupt JSON values", async () => {
		await seed({ namespace: "corrupt", key: "bad", value: "{not json" });
		const out = await asAdmin((a) => a.list({ namespace: "corrupt" }));
		expect(out.items[0]?.value).toBe("{not json");
	});

	it("rejects invalid filters", async () => {
		const long = "x".repeat(201);
		await expect(asAdmin((a) => a.list({ namespace: long }))).rejects.toBeInstanceOf(
			KvValidationError,
		);
		await expect(asAdmin((a) => a.list({ prefix: long }))).rejects.toBeInstanceOf(
			KvValidationError,
		);
		await expect(asAdmin((a) => a.list({ limit: 0 }))).rejects.toBeInstanceOf(KvValidationError);
		await expect(asAdmin((a) => a.list({ limit: 1.5 }))).rejects.toBeInstanceOf(KvValidationError);
		await expect(asAdmin((a) => a.list({ offset: -1 }))).rejects.toBeInstanceOf(KvValidationError);
		await expect(asAdmin((a) => a.list({ offset: 0.5 }))).rejects.toBeInstanceOf(KvValidationError);
	});
});

describe("KvAdmin.namespaces", () => {
	it("returns per-namespace counts ordered by name", async () => {
		await seed({ namespace: "ns-a", key: "1", value: "1" });
		await seed({ namespace: "ns-a", key: "2", value: "1" });
		await seed({ namespace: "ns-b", key: "1", value: "1" });
		const out = await asAdmin((a) => a.namespaces());
		const nsA = out.find((n) => n.namespace === "ns-a");
		const nsB = out.find((n) => n.namespace === "ns-b");
		expect(nsA?.count).toBe(2);
		expect(nsB?.count).toBe(1);
		const names = out.map((n) => n.namespace);
		expect([...names].sort()).toEqual(names);
	});
});

describe("KvAdmin.get", () => {
	it("returns the entry for an exact scope slice, expired included", async () => {
		await seed({
			namespace: "getns",
			key: "g1",
			value: '{"v":2}',
			tenantId: 7,
			expiresAt: Date.now() - 500,
		});
		const entry = await asAdmin((a) => a.get({ namespace: "getns", key: "g1", tenantId: 7 }));
		expect(entry).toMatchObject({ expired: true, tenantId: 7, version: 1 });
		expect(entry?.value).toEqual({ v: 2 });
		const missing = await asAdmin((a) => a.get({ namespace: "getns", key: "nope", tenantId: 7 }));
		expect(missing).toBeNull();
	});

	it("treats tenant scope as dropping ownerId and accepts numeric strings", async () => {
		await seed({ namespace: "sc", key: "s1", value: "1", tenantId: 4, ownerId: null });
		const entry = await asAdmin((a) =>
			a.get({ namespace: "sc", key: "s1", tenantId: "4", ownerId: "ignored" }),
		);
		expect(entry).not.toBeNull();
		expect(entry?.tenantId).toBe(4);
		expect(entry?.ownerId).toBeNull();
	});

	it("rejects invalid keys and scopes", async () => {
		await expect(asAdmin((a) => a.get({ namespace: "", key: "k" }))).rejects.toBeInstanceOf(
			KvValidationError,
		);
		await expect(
			asAdmin((a) => a.get({ namespace: "x".repeat(201), key: "k" })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.get({ namespace: "n", key: "k", tenantId: "abc" })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.get({ namespace: "n", key: "k", tenantId: 1.5 })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.get({ namespace: "n", key: "k", ownerId: 42 as never })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.get({ namespace: "n", key: "k", ownerId: "x".repeat(201) })),
		).rejects.toBeInstanceOf(KvValidationError);
	});
});

describe("KvAdmin.set", () => {
	it("creates a global entry and upserts it with a version bump", async () => {
		const created = await asAdmin((a) => a.set({ namespace: "setns", key: "s1", value: { a: 1 } }));
		expect(created).toMatchObject({
			namespace: "setns",
			key: "s1",
			tenantId: null,
			ownerId: null,
			version: 1,
			expiresAt: null,
			expired: false,
		});
		expect(created.value).toEqual({ a: 1 });
		const updated = await asAdmin((a) => a.set({ namespace: "setns", key: "s1", value: 2 }));
		expect(updated.version).toBe(2);
		expect(updated.value).toBe(2);
	});

	it("scopes entries by tenant and owner slices", async () => {
		await asAdmin((a) =>
			a.set({
				namespace: "scoped",
				key: "k",
				value: "t",
				tenantId: 9,
				ownerId: "shadowed",
			}),
		);
		const tenantRow = await asAdmin((a) => a.get({ namespace: "scoped", key: "k", tenantId: 9 }));
		expect(tenantRow?.value).toBe("t");
		expect(tenantRow?.ownerId).toBeNull();
		await asAdmin((a) => a.set({ namespace: "scoped", key: "k", value: "o", ownerId: "u2" }));
		const ownerRow = await asAdmin((a) => a.get({ namespace: "scoped", key: "k", ownerId: "u2" }));
		expect(ownerRow?.value).toBe("o");
		const globalRow = await asAdmin((a) => a.get({ namespace: "scoped", key: "k" }));
		expect(globalRow).toBeNull();
	});

	it("preserves TTL on live rows, clears on null, sets on a number", async () => {
		const before = Date.now();
		await asAdmin((a) => a.set({ namespace: "ttlset", key: "k", value: 1, ttlMs: 60_000 }));
		const kept = await asAdmin((a) => a.set({ namespace: "ttlset", key: "k", value: 2 }));
		expect(kept.expiresAt).not.toBeNull();
		expect(kept.expiresAt!).toBeGreaterThanOrEqual(before + 55_000);
		const cleared = await asAdmin((a) =>
			a.set({ namespace: "ttlset", key: "k", value: 3, ttlMs: null }),
		);
		expect(cleared.expiresAt).toBeNull();
		const reset = await asAdmin((a) =>
			a.set({ namespace: "ttlset", key: "k", value: 4, ttlMs: 30_000 }),
		);
		expect(reset.expiresAt).not.toBeNull();
		expect(reset.expiresAt!).toBeLessThanOrEqual(Date.now() + 30_500);
	});

	it("revives expired rows without expiry when ttlMs is absent", async () => {
		await seed({
			namespace: "revive",
			key: "k",
			value: "1",
			expiresAt: Date.now() - 1000,
		});
		const revived = await asAdmin((a) => a.set({ namespace: "revive", key: "k", value: "2" }));
		expect(revived.expired).toBe(false);
		expect(revived.expiresAt).toBeNull();
		expect(revived.version).toBe(2);
	});

	it("applies the CAS guard: success, conflict and not-found", async () => {
		await asAdmin((a) => a.set({ namespace: "cas", key: "k", value: 1 }));
		const ok = await asAdmin((a) =>
			a.set({ namespace: "cas", key: "k", value: 2, expectedVersion: 1 }),
		);
		expect(ok.version).toBe(2);
		const conflict = await runErr(ADMIN, (a) =>
			a.set({ namespace: "cas", key: "k", value: 3, expectedVersion: 1 }),
		);
		expect(conflict).toBeInstanceOf(KvConflictError);
		expect((conflict as KvConflictError).actualVersion).toBe(2);
		const missing = await runErr(ADMIN, (a) =>
			a.set({ namespace: "cas", key: "nope", value: 1, expectedVersion: 1 }),
		);
		expect(missing).toBeInstanceOf(KvNotFoundError);
		await seed({
			namespace: "cas",
			key: "dead",
			value: "1",
			expiresAt: Date.now() - 1000,
		});
		const expired = await runErr(ADMIN, (a) =>
			a.set({ namespace: "cas", key: "dead", value: 1, expectedVersion: 1 }),
		);
		expect(expired).toBeInstanceOf(KvNotFoundError);
		const gone = await asAdmin((a) => a.get({ namespace: "cas", key: "dead" }));
		expect(gone).toBeNull();
	});

	it("rejects invalid versions, values, keys and scopes", async () => {
		await expect(
			asAdmin((a) => a.set({ namespace: "v", key: "k", value: 1, expectedVersion: 0 })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.set({ namespace: "v", key: "k", value: 1, expectedVersion: 1.5 })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.set({ namespace: "", key: "k", value: 1 })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.set({ namespace: "v", key: "", value: 1 })),
		).rejects.toBeInstanceOf(KvValidationError);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await expect(
			asAdmin((a) => a.set({ namespace: "v", key: "k", value: circular })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.set({ namespace: "v", key: "k", value: undefined })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.set({ namespace: "v", key: "k", value: 1, ttlMs: -5 })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) => a.set({ namespace: "v", key: "k", value: 1, tenantId: "abc" })),
		).rejects.toBeInstanceOf(KvValidationError);
		await expect(
			asAdmin((a) =>
				a.set({
					namespace: "v",
					key: "k",
					value: 1,
					ownerId: "x".repeat(201),
				}),
			),
		).rejects.toBeInstanceOf(KvValidationError);
	});
});

describe("KvAdmin.remove", () => {
	it("deletes live and expired rows, reports missing as false", async () => {
		await asAdmin((a) => a.set({ namespace: "del", key: "k", value: 1 }));
		expect(await asAdmin((a) => a.remove({ namespace: "del", key: "k" }))).toBe(true);
		expect(await asAdmin((a) => a.remove({ namespace: "del", key: "k" }))).toBe(false);
		await seed({
			namespace: "del",
			key: "dead",
			value: "1",
			expiresAt: Date.now() - 1000,
		});
		expect(await asAdmin((a) => a.remove({ namespace: "del", key: "dead" }))).toBe(true);
	});

	it("scopes removal to the exact slice", async () => {
		await asAdmin((a) => a.set({ namespace: "delscope", key: "k", value: 1, tenantId: 2 }));
		await asAdmin((a) => a.set({ namespace: "delscope", key: "k", value: 2, ownerId: "u1" }));
		await asAdmin((a) => a.remove({ namespace: "delscope", key: "k", tenantId: 2 }));
		const tenant = await asAdmin((a) => a.get({ namespace: "delscope", key: "k", tenantId: 2 }));
		const owner = await asAdmin((a) => a.get({ namespace: "delscope", key: "k", ownerId: "u1" }));
		expect(tenant).toBeNull();
		expect(owner?.value).toBe(2);
	});

	it("rejects invalid targets", async () => {
		await expect(asAdmin((a) => a.remove({ namespace: "", key: "k" }))).rejects.toBeInstanceOf(
			KvValidationError,
		);
		await expect(
			asAdmin((a) => a.remove({ namespace: "n", key: "k", tenantId: {} as never })),
		).rejects.toBeInstanceOf(KvValidationError);
	});
});

describe("KvAdmin entry shape", () => {
	it("exposes scope slices: tenant, owner and global entries stay distinct", async () => {
		const tenant = await asAdmin((a) =>
			a.set({ namespace: "shapes", key: "t", value: 1, tenantId: 5 }),
		);
		expect(tenant).toMatchObject({ tenantId: 5, ownerId: null, expired: false });
		const owner = await asAdmin((a) =>
			a.set({ namespace: "shapes", key: "o", value: 1, ownerId: "owner-1" }),
		);
		expect(owner).toMatchObject({ tenantId: null, ownerId: "owner-1" });
		const global = await asAdmin((a) => a.set({ namespace: "shapes", key: "g", value: 1 }));
		expect(global).toMatchObject({ tenantId: null, ownerId: null });
	});
});
