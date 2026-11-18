import { beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import { eq } from "drizzle-orm";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Forbidden, Principal } from "@ktb/authz";
import { kvOpDuration, kvOps, kvRows, tagged } from "@ktb/observability";
import { Tenant, TenantAccess, type Tenant as TenantT } from "@ktb/tenant";

import { kvEntries, KV_TEST_DDL, plugins } from "./index.ts";
import {
	Kv,
	KvConflictError,
	KvLive,
	KvNotFoundError,
	KvTypeError,
	KvValidationError,
	type KvShape,
} from "./service.ts";

let db: DbClient;
let runtime: ManagedRuntime.ManagedRuntime<Kv, never>;

beforeAll(() => {
	db = makeDb(makeD1(KV_TEST_DDL));
	// Built here (not at module top level) so Layer.succeed captures the
	// initialized DbClient — beforeAll runs before any test.
	runtime = ManagedRuntime.make(Layer.provide(KvLive, Layer.succeed(Db, db)));
});

/** Effect requiring only `Kv` — run through the shared runtime. */
const eff = <A, E>(f: (kv: KvShape) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const svc = yield* Kv;
		return yield* f(svc);
	});

const run = <A, E>(effect: Effect.Effect<A, E, Kv>) => runtime.runPromise(effect);

/** Run an effect and return its typed error instead of throwing. */
const runErr = <A, E>(effect: Effect.Effect<A, E, Kv>) => run(Effect.flip(effect));

const asUser = <A, E>(userId: string, effect: Effect.Effect<A, E, Kv>) =>
	run(Effect.provideService(effect, Principal, { userId }));

const asUserErr = <A, E>(userId: string, effect: Effect.Effect<A, E, Kv>) =>
	asUser(userId, Effect.flip(effect));

const tenant = (id: number): TenantT => ({
	id,
	kind: "clinic",
	slug: `clinic-${id}`,
	role: "member",
});

const inTenant = <A, E>(tenantId: number, effect: Effect.Effect<A, E, Kv>) =>
	run(Effect.provideService(effect, Tenant, tenant(tenantId)));

const withAccess = <A, E>(ids: readonly (string | number)[], effect: Effect.Effect<A, E, Kv>) =>
	run(Effect.provideService(effect, TenantAccess, ids));

const GLOBAL = {} as const;

const seedRow = (over: Partial<typeof kvEntries.$inferInsert> = {}) =>
	db.insert(kvEntries).values({
		namespace: "seed",
		key: "k",
		value: "1",
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	});

const countRows = async (namespace: string, key: string) =>
	(await db.select().from(kvEntries).where(eq(kvEntries.namespace, namespace))).filter(
		(r) => r.key === key,
	).length;

describe("plugin manifest", () => {
	it("contributes kv.tables and kv.services", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"kv.tables",
			"kv.services",
			"kv.admin.services",
			"kv.chrome",
			"kv.panel",
		]);
	});
});

describe("get/set", () => {
	it("round-trips a JSON value in global scope and bumps version on overwrite", async () => {
		const entry = await run(
			eff((kv) => kv.set("t.set", "greeting", { msg: "hi", n: 1 }, { scope: GLOBAL })),
		);
		expect(entry.value).toEqual({ msg: "hi", n: 1 });
		expect(entry.version).toBe(1);
		expect(entry.expiresAt).toBeNull();
		expect(entry.tenantId).toBeNull();
		expect(entry.ownerId).toBeNull();

		const got = await run(eff((kv) => kv.get<{ msg: string }>("t.set", "greeting", GLOBAL)));
		expect(got?.value.msg).toBe("hi");

		const again = await run(eff((kv) => kv.set("t.set", "greeting", "plain", { scope: GLOBAL })));
		expect(again.version).toBe(2);
		expect(again.value).toBe("plain");
	});

	it("returns null for a missing key", async () => {
		expect(await run(eff((kv) => kv.get("t.set", "missing", GLOBAL)))).toBeNull();
	});

	it("derives global scope when no scope, tenant or principal is bound", async () => {
		await run(eff((kv) => kv.set("t.set", "implicit", 42)));
		const got = await run(eff((kv) => kv.get<number>("t.set", "implicit")));
		expect(got?.value).toBe(42);
		expect(got?.ownerId).toBeNull();
	});

	it("sets and clears expires_at via ttlMs", async () => {
		const before = Date.now();
		const withTtl = await run(
			eff((kv) => kv.set("t.ttl", "a", 1, { scope: GLOBAL, ttlMs: 60_000 })),
		);
		expect(withTtl.expiresAt).not.toBeNull();
		expect(withTtl.expiresAt!).toBeGreaterThanOrEqual(before + 60_000);
		expect(withTtl.expiresAt!).toBeLessThanOrEqual(Date.now() + 60_000);

		// set() without ttlMs clears the expiry (SET semantics).
		const cleared = await run(eff((kv) => kv.set("t.ttl", "a", 2, { scope: GLOBAL })));
		expect(cleared.expiresAt).toBeNull();
	});

	it("rejects invalid field names and non-JSON values", async () => {
		const bad = [
			eff((kv) => kv.set("", "k", 1, { scope: GLOBAL })),
			eff((kv) => kv.set("ns", "", 1, { scope: GLOBAL })),
			eff((kv) => kv.set("ns", "k".repeat(201), 1, { scope: GLOBAL })),
			eff((kv) => kv.set("ns", "k", undefined, { scope: GLOBAL })),
			eff((kv) => kv.set("ns", "k", Number.NaN, { scope: GLOBAL })),
			eff((kv) => kv.set("ns", "k", Number.POSITIVE_INFINITY, { scope: GLOBAL })),
			eff((kv) => kv.set("ns", "k", () => 1, { scope: GLOBAL })),
		];
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		bad.push(eff((kv) => kv.set("ns", "k", circular, { scope: GLOBAL })));
		for (const e of bad) {
			expect(await runErr(e)).toBeInstanceOf(KvValidationError);
		}
	});

	it("rejects invalid ttlMs", async () => {
		for (const ttlMs of [0, -5, Number.NaN]) {
			const err = await runErr(eff((kv) => kv.set("t.ttl", "bad", 1, { ttlMs })));
			expect(err).toBeInstanceOf(KvValidationError);
		}
	});

	it("rejects values over MAX_VALUE_BYTES on set and setIfAbsent", async () => {
		const big = "x".repeat(256 * 1024);
		const err = await runErr(eff((kv) => kv.set("t.size", "big", big, { scope: GLOBAL })));
		expect(err).toBeInstanceOf(KvValidationError);
		expect((err as KvValidationError).reason).toContain("serialized bytes");
		const err2 = await runErr(
			eff((kv) => kv.setIfAbsent("t.size", "big2", big, { scope: GLOBAL })),
		);
		expect(err2).toBeInstanceOf(KvValidationError);
		// Just under the cap still writes.
		const ok = await run(eff((kv) => kv.set("t.size", "ok", "y".repeat(1024), { scope: GLOBAL })));
		expect(ok.version).toBe(1);
	});
});

describe("lazy expiry + sweep", () => {
	it("get treats an expired row as absent and deletes it", async () => {
		await seedRow({ namespace: "t.exp", key: "old", expiresAt: Date.now() - 1_000 });
		expect(await run(eff((kv) => kv.get("t.exp", "old", GLOBAL)))).toBeNull();
		expect(await countRows("t.exp", "old")).toBe(0);
	});

	it("keys excludes expired rows", async () => {
		await seedRow({ namespace: "t.keyexp", key: "live", value: "1" });
		await seedRow({
			namespace: "t.keyexp",
			key: "dead",
			value: "1",
			expiresAt: Date.now() - 1_000,
		});
		const keys = await run(eff((kv) => kv.keys("t.keyexp", GLOBAL)));
		expect(keys).toContain("live");
		expect(keys).not.toContain("dead");
	});

	it("sweepExpired removes expired rows across namespaces and reports the count", async () => {
		await seedRow({ namespace: "t.sweep", key: "e1", expiresAt: Date.now() - 10 });
		await seedRow({ namespace: "t.sweep", key: "e2", expiresAt: Date.now() - 5 });
		await seedRow({ namespace: "t.sweep", key: "live", value: "1" });
		const removed = await run(eff((kv) => kv.sweepExpired()));
		expect(removed).toBeGreaterThanOrEqual(2);
		expect(await countRows("t.sweep", "e1")).toBe(0);
		expect(await countRows("t.sweep", "e2")).toBe(0);
		expect(await countRows("t.sweep", "live")).toBe(1);
		// Second sweep finds nothing left from this test's rows.
		const again = await run(eff((kv) => kv.sweepExpired()));
		expect(again).toBe(0);
	});
});

describe("expire", () => {
	it("sets a deadline on a live row and reports missing rows", async () => {
		await run(eff((kv) => kv.set("t.expire", "a", 1, { scope: GLOBAL })));
		const before = Date.now();
		expect(await run(eff((kv) => kv.expire("t.expire", "a", 30_000, GLOBAL)))).toBe(true);
		const got = await run(eff((kv) => kv.get<number>("t.expire", "a", GLOBAL)));
		expect(got?.expiresAt).toBeGreaterThanOrEqual(before + 30_000);
		expect(await run(eff((kv) => kv.expire("t.expire", "missing", 30_000, GLOBAL)))).toBe(false);
	});

	it("rejects invalid ttlMs and already-expired rows", async () => {
		expect(await runErr(eff((kv) => kv.expire("t.expire", "a", 0, GLOBAL)))).toBeInstanceOf(
			KvValidationError,
		);
		await seedRow({ namespace: "t.expire", key: "dead", expiresAt: Date.now() - 1 });
		expect(await run(eff((kv) => kv.expire("t.expire", "dead", 30_000, GLOBAL)))).toBe(false);
	});

	it("lazily deletes an already-expired row and reports false", async () => {
		await seedRow({
			namespace: "t.expire",
			key: "dead2",
			value: "1",
			expiresAt: Date.now() - 1,
		});
		expect(await run(eff((kv) => kv.expire("t.expire", "dead2", 30_000, GLOBAL)))).toBe(false);
		expect(await countRows("t.expire", "dead2")).toBe(0);
	});
});

describe("CAS set (expectedVersion)", () => {
	it("succeeds when the version matches and bumps it", async () => {
		const first = await run(eff((kv) => kv.set("t.cas", "a", 1, { scope: GLOBAL })));
		const second = await run(
			eff((kv) => kv.set("t.cas", "a", 2, { scope: GLOBAL, expectedVersion: first.version })),
		);
		expect(second.version).toBe(2);
		expect(second.value).toBe(2);
	});

	it("fails KvConflictError on version mismatch", async () => {
		const err = await runErr(
			eff((kv) => kv.set("t.cas", "a", 3, { scope: GLOBAL, expectedVersion: 1 })),
		);
		expect(err).toBeInstanceOf(KvConflictError);
		expect((err as InstanceType<typeof KvConflictError>).actualVersion).toBe(2);
	});

	it("fails KvNotFoundError when the row is missing", async () => {
		const err = await runErr(
			eff((kv) => kv.set("t.cas", "absent", 1, { scope: GLOBAL, expectedVersion: 1 })),
		);
		expect(err).toBeInstanceOf(KvNotFoundError);
	});

	it("treats an expired row as not found and removes it", async () => {
		await seedRow({
			namespace: "t.cas",
			key: "stale",
			value: "9",
			expiresAt: Date.now() - 1,
			version: 7,
		});
		const err = await runErr(
			eff((kv) => kv.set("t.cas", "stale", 1, { scope: GLOBAL, expectedVersion: 7 })),
		);
		expect(err).toBeInstanceOf(KvNotFoundError);
		expect(await countRows("t.cas", "stale")).toBe(0);
	});

	it("rejects a non-positive-integer expectedVersion", async () => {
		for (const expectedVersion of [0, 1.5]) {
			const err = await runErr(
				eff((kv) => kv.set("t.cas", "a", 1, { scope: GLOBAL, expectedVersion })),
			);
			expect(err).toBeInstanceOf(KvValidationError);
		}
	});
});

describe("setIfAbsent", () => {
	it("writes once then reports the key as taken", async () => {
		expect(await run(eff((kv) => kv.setIfAbsent("t.nx", "a", 1, { scope: GLOBAL })))).toBe(true);
		expect(await run(eff((kv) => kv.setIfAbsent("t.nx", "a", 2, { scope: GLOBAL })))).toBe(false);
		expect((await run(eff((kv) => kv.get<number>("t.nx", "a", GLOBAL))))?.value).toBe(1);
	});

	it("replaces an expired row", async () => {
		await seedRow({
			namespace: "t.nx",
			key: "stale",
			value: "0",
			expiresAt: Date.now() - 1,
		});
		expect(await run(eff((kv) => kv.setIfAbsent("t.nx", "stale", 5, { scope: GLOBAL })))).toBe(
			true,
		);
		expect((await run(eff((kv) => kv.get<number>("t.nx", "stale", GLOBAL))))?.value).toBe(5);
	});

	it("applies ttlMs on insert", async () => {
		expect(
			await run(eff((kv) => kv.setIfAbsent("t.nx", "ttl", 1, { scope: GLOBAL, ttlMs: 60_000 }))),
		).toBe(true);
		const got = await run(eff((kv) => kv.get<number>("t.nx", "ttl", GLOBAL)));
		expect(got?.expiresAt).not.toBeNull();
	});

	it("propagates validation errors", async () => {
		const err = await runErr(
			eff((kv) => kv.setIfAbsent("t.nx", "bad", undefined, { scope: GLOBAL })),
		);
		expect(err).toBeInstanceOf(KvValidationError);
	});
});

describe("delete", () => {
	it("deletes a live row once", async () => {
		await run(eff((kv) => kv.set("t.del", "a", 1, { scope: GLOBAL })));
		expect(await run(eff((kv) => kv.delete("t.del", "a", GLOBAL)))).toBe(true);
		expect(await run(eff((kv) => kv.delete("t.del", "a", GLOBAL)))).toBe(false);
	});

	it("deletes a live row that still has a future expiry", async () => {
		await run(eff((kv) => kv.set("t.del", "ttl", 1, { scope: GLOBAL, ttlMs: 60_000 })));
		expect(await run(eff((kv) => kv.delete("t.del", "ttl", GLOBAL)))).toBe(true);
	});

	it("removes an expired row but reports false", async () => {
		await seedRow({
			namespace: "t.del",
			key: "dead",
			value: "1",
			expiresAt: Date.now() - 1,
		});
		expect(await run(eff((kv) => kv.delete("t.del", "dead", GLOBAL)))).toBe(false);
		expect(await countRows("t.del", "dead")).toBe(0);
	});
});

describe("increment", () => {
	it("starts a missing key at the increment and defaults by to 1", async () => {
		expect(await run(eff((kv) => kv.increment("t.inc", "a", undefined, { scope: GLOBAL })))).toBe(
			1,
		);
		expect(await run(eff((kv) => kv.increment("t.inc", "a", 4, { scope: GLOBAL })))).toBe(5);
		expect(await run(eff((kv) => kv.increment("t.inc", "b", -2, { scope: GLOBAL })))).toBe(-2);
	});

	it("adds to an existing numeric value atomically", async () => {
		await run(eff((kv) => kv.set("t.inc", "num", 10, { scope: GLOBAL })));
		expect(await run(eff((kv) => kv.increment("t.inc", "num", 0.5, { scope: GLOBAL })))).toBe(10.5);
		const got = await run(eff((kv) => kv.get<number>("t.inc", "num", GLOBAL)));
		expect(got?.version).toBe(2);
	});

	it("fails KvTypeError on a non-numeric value and leaves it untouched", async () => {
		await run(eff((kv) => kv.set("t.inc", "str", "abc", { scope: GLOBAL })));
		const err = await runErr(eff((kv) => kv.increment("t.inc", "str", 1, { scope: GLOBAL })));
		expect(err).toBeInstanceOf(KvTypeError);
		expect((await run(eff((kv) => kv.get("t.inc", "str", GLOBAL))))?.value).toBe("abc");
	});

	it("resets an expired numeric row to the increment", async () => {
		await seedRow({
			namespace: "t.inc",
			key: "stale",
			value: "41",
			expiresAt: Date.now() - 1,
		});
		expect(await run(eff((kv) => kv.increment("t.inc", "stale", 1, { scope: GLOBAL })))).toBe(1);
	});

	it("resets an expired non-numeric row instead of erroring", async () => {
		await seedRow({
			namespace: "t.inc",
			key: "stale-str",
			value: '"abc"',
			expiresAt: Date.now() - 1,
		});
		expect(await run(eff((kv) => kv.increment("t.inc", "stale-str", 3, { scope: GLOBAL })))).toBe(
			3,
		);
	});

	it("preserves a live TTL and applies ttlMs when given", async () => {
		const first = await run(
			eff((kv) => kv.set("t.inc", "ttl", 1, { scope: GLOBAL, ttlMs: 60_000 })),
		);
		await run(eff((kv) => kv.increment("t.inc", "ttl", 1, { scope: GLOBAL })));
		const preserved = await run(eff((kv) => kv.get<number>("t.inc", "ttl", GLOBAL)));
		expect(preserved?.expiresAt).toBe(first.expiresAt);

		const before = Date.now();
		await run(eff((kv) => kv.increment("t.inc", "ttl", 1, { scope: GLOBAL, ttlMs: 30_000 })));
		const renewed = await run(eff((kv) => kv.get<number>("t.inc", "ttl", GLOBAL)));
		expect(renewed?.expiresAt).toBeGreaterThanOrEqual(before + 30_000);
	});

	it("keeps expires_at untouched when ttlMs is passed on a non-numeric value", async () => {
		await run(eff((kv) => kv.set("t.inc", "str-ttl", "abc", { scope: GLOBAL, ttlMs: 60_000 })));
		const before = await run(eff((kv) => kv.get("t.inc", "str-ttl", GLOBAL)));
		const err = await runErr(
			eff((kv) => kv.increment("t.inc", "str-ttl", 1, { scope: GLOBAL, ttlMs: 30_000 })),
		);
		expect(err).toBeInstanceOf(KvTypeError);
		const after = await run(eff((kv) => kv.get("t.inc", "str-ttl", GLOBAL)));
		expect(after?.expiresAt).toBe(before?.expiresAt);
		expect(after?.version).toBe(before?.version);
	});

	it("rejects a non-finite or non-number increment", async () => {
		for (const by of [Number.NaN, Number.POSITIVE_INFINITY, "x" as unknown as number]) {
			const err = await runErr(eff((kv) => kv.increment("t.inc", "bad", by, { scope: GLOBAL })));
			expect(err).toBeInstanceOf(KvValidationError);
		}
	});
});

describe("keys", () => {
	it("lists live keys of one namespace+scope, sorted, with prefix and limit", async () => {
		await run(eff((kv) => kv.set("t.keys", "a1", 1, { scope: GLOBAL })));
		await run(eff((kv) => kv.set("t.keys", "a2", 1, { scope: GLOBAL })));
		await run(eff((kv) => kv.set("t.keys", "b1", 1, { scope: GLOBAL })));
		await run(eff((kv) => kv.set("t.keys", "a-dead", 1, { scope: GLOBAL, ttlMs: 1 })));
		await run(eff((kv) => kv.set("t.keys.other", "a1", 1, { scope: GLOBAL })));
		// Force the ttl row to be expired deterministically.
		await db
			.update(kvEntries)
			.set({ expiresAt: Date.now() - 1 })
			.where(eq(kvEntries.key, "a-dead"));

		const all = await run(eff((kv) => kv.keys("t.keys", GLOBAL)));
		expect(all).toEqual(["a1", "a2", "b1"]);

		const prefixed = await run(eff((kv) => kv.keys("t.keys", GLOBAL, { prefix: "a" })));
		expect(prefixed).toEqual(["a1", "a2"]);

		const emptyPrefix = await run(eff((kv) => kv.keys("t.keys", GLOBAL, { prefix: "" })));
		expect(emptyPrefix).toEqual(all);

		const limited = await run(eff((kv) => kv.keys("t.keys", GLOBAL, { limit: 2 })));
		expect(limited).toEqual(["a1", "a2"]);
	});

	it("matches astral (non-BMP) prefixes character-wise", async () => {
		// "😀" is one SQLite character but two UTF-16 code units — a
		// JS-length-based substr would mis-slice it.
		await run(eff((kv) => kv.set("t.keys.emoji", "😀one", 1, { scope: GLOBAL })));
		await run(eff((kv) => kv.set("t.keys.emoji", "😀two", 1, { scope: GLOBAL })));
		await run(eff((kv) => kv.set("t.keys.emoji", "x😀three", 1, { scope: GLOBAL })));
		const keys = await run(eff((kv) => kv.keys("t.keys.emoji", GLOBAL, { prefix: "😀" })));
		expect(keys).toEqual(["😀one", "😀two"]);
	});

	it("scopes key listing to the resolved slice", async () => {
		await asUser(
			"u-keys",
			eff((kv) => kv.set("t.keys.scope", "mine", 1)),
		);
		await asUser(
			"u-keys",
			eff((kv) => kv.set("t.keys.scope", "other-ns", 1)),
		);
		const mine = await asUser(
			"u-keys",
			eff((kv) => kv.keys("t.keys.scope")),
		);
		expect(mine).toContain("mine");
		// Tenant slice lists only tenant rows (none here).
		expect(
			await inTenant(
				9,
				eff((kv) => kv.keys("t.keys.scope")),
			),
		).toEqual([]);
		// The same namespace under the global slice is empty.
		expect(await run(eff((kv) => kv.keys("t.keys.scope", GLOBAL)))).toEqual([]);
	});

	it("rejects invalid limit, prefix and namespace", async () => {
		expect(await runErr(eff((kv) => kv.keys("", GLOBAL)))).toBeInstanceOf(KvValidationError);
		for (const limit of [0, 1.5]) {
			const err = await runErr(eff((kv) => kv.keys("t.keys", GLOBAL, { limit })));
			expect(err).toBeInstanceOf(KvValidationError);
		}
		const longPrefix = await runErr(
			eff((kv) => kv.keys("t.keys", GLOBAL, { prefix: "p".repeat(201) })),
		);
		expect(longPrefix).toBeInstanceOf(KvValidationError);
	});
});

describe("registerSchema", () => {
	it("consults the registered validator on set and setIfAbsent", async () => {
		await run(eff((kv) => kv.registerSchema("t.schema", (v) => typeof v === "number" && v > 0)));
		await run(eff((kv) => kv.set("t.schema", "ok", 5, { scope: GLOBAL })));
		const badSet = await runErr(eff((kv) => kv.set("t.schema", "bad", -1, { scope: GLOBAL })));
		expect(badSet).toBeInstanceOf(KvValidationError);
		const badNx = await runErr(
			eff((kv) => kv.setIfAbsent("t.schema", "bad2", "x", { scope: GLOBAL })),
		);
		expect(badNx).toBeInstanceOf(KvValidationError);
	});

	it("rejects an invalid namespace", async () => {
		const err = await runErr(eff((kv) => kv.registerSchema("", () => true)));
		expect(err).toBeInstanceOf(KvValidationError);
	});

	it("is bypassed by increment, which enforces the numeric shape itself", async () => {
		// Pins the documented contract: schemas guard set/setIfAbsent
		// values only; increment operates on the numeric-counter shape.
		await run(eff((kv) => kv.registerSchema("t.schema-inc", (v) => typeof v === "string")));
		const badSet = await runErr(eff((kv) => kv.set("t.schema-inc", "x", 1, { scope: GLOBAL })));
		expect(badSet).toBeInstanceOf(KvValidationError);
		expect(await run(eff((kv) => kv.increment("t.schema-inc", "c", 1, { scope: GLOBAL })))).toBe(1);
	});
});

describe("scope resolution + fencing", () => {
	it("derives personal scope from the bound principal", async () => {
		await asUser(
			"u1",
			eff((kv) => kv.set("t.scope", "k", "mine")),
		);
		const got = await asUser(
			"u1",
			eff((kv) => kv.get<string>("t.scope", "k")),
		);
		expect(got?.value).toBe("mine");
		expect(got?.ownerId).toBe("u1");
		expect(got?.tenantId).toBeNull();
		// Another user sees a different slice; global sees nothing.
		expect(
			await asUser(
				"u2",
				eff((kv) => kv.get("t.scope", "k")),
			),
		).toBeNull();
		expect(await run(eff((kv) => kv.get("t.scope", "k", GLOBAL)))).toBeNull();
	});

	it("denies an explicit ownerId that differs from the bound principal", async () => {
		const err = await asUserErr(
			"u1",
			eff((kv) => kv.get("t.scope", "k", { ownerId: "u2" })),
		);
		expect(err).toBeInstanceOf(Forbidden);
		// Same owner passes; system context (no principal) is trusted.
		expect(
			await asUser(
				"u1",
				eff((kv) => kv.get("t.scope", "k", { ownerId: "u1" })),
			),
		).not.toBeNull();
		await run(eff((kv) => kv.set("t.scope", "sys", 1, { scope: { ownerId: "sys-owner" } })));
	});

	it("derives tenant scope from the bound tenant and stores owner_id NULL", async () => {
		await inTenant(
			5,
			eff((kv) => kv.set("t.scope", "tk", "tenant-val")),
		);
		const got = await inTenant(
			5,
			eff((kv) => kv.get<string>("t.scope", "tk")),
		);
		expect(got?.value).toBe("tenant-val");
		expect(got?.tenantId).toBe(5);
		expect(got?.ownerId).toBeNull();
		// The same key in global scope is a different row.
		expect(await run(eff((kv) => kv.get("t.scope", "tk", GLOBAL)))).toBeNull();
	});

	it("accepts numeric-string tenantIds and drops ownerId on tenant rows", async () => {
		await withAccess(
			[5],
			eff((kv) => kv.set("t.scope", "tk2", 1, { scope: { tenantId: "5", ownerId: "ignored" } })),
		);
		const got = await withAccess(
			[5],
			eff((kv) => kv.get<number>("t.scope", "tk2", { tenantId: 5 })),
		);
		expect(got?.value).toBe(1);
		expect(got?.ownerId).toBeNull();
	});

	it("denies a tenant outside the accessible set", async () => {
		const err = await withAccess(
			[6],
			Effect.flip(eff((kv) => kv.get("t.scope", "tk", { tenantId: 5 }))),
		);
		expect(err).toBeInstanceOf(Forbidden);
		// Personal scope (empty accessible set) denies too.
		const err2 = await runErr(eff((kv) => kv.get("t.scope", "tk", { tenantId: 5 })));
		expect(err2).toBeInstanceOf(Forbidden);
	});

	it("rejects malformed scope ids", async () => {
		const cases: readonly {
			readonly tenantId?: number | string | null;
			readonly ownerId?: string | null;
		}[] = [
			{ tenantId: "abc" },
			{ tenantId: 1.5 },
			{ tenantId: true as unknown as number },
			{ ownerId: 7 as unknown as string },
			{ ownerId: "o".repeat(201) },
		];
		for (const scope of cases) {
			const err = await runErr(eff((kv) => kv.get("t.scope", "k", scope)));
			expect(err).toBeInstanceOf(KvValidationError);
		}
		// Blank strings normalize to NULL (global slice).
		expect(
			await run(eff((kv) => kv.get("t.scope", "k", { tenantId: "  ", ownerId: "" }))),
		).toBeNull();
	});

	it("isolates the same key across tenant and personal slices", async () => {
		await inTenant(
			7,
			eff((kv) => kv.set("t.iso", "k", "tenant-7")),
		);
		await asUser(
			"u-iso",
			eff((kv) => kv.set("t.iso", "k", "user")),
		);
		await run(eff((kv) => kv.set("t.iso", "k", "global", { scope: GLOBAL })));
		expect(
			await inTenant(
				7,
				eff((kv) => kv.get<string>("t.iso", "k")),
			),
		).toMatchObject({
			value: "tenant-7",
		});
		expect(
			await asUser(
				"u-iso",
				eff((kv) => kv.get<string>("t.iso", "k")),
			),
		).toMatchObject({
			value: "user",
		});
		expect(await run(eff((kv) => kv.get<string>("t.iso", "k", GLOBAL)))).toMatchObject({
			value: "global",
		});
	});
});

describe("telemetry (T-131)", () => {
	/** In-memory tracer — same shape as packages/observability sampler tests. */
	const makeTracer = () => {
		const spans: Tracer.NativeSpan[] = [];
		const tracer = Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		});
		return { tracer, spans };
	};

	// The metric registry is process-wide — assert deltas, not absolutes.
	const metricCount = <A, S>(metric: Metric.Metric<A, S>) =>
		Effect.runPromise(Metric.value(metric)).then((state) => {
			const count = (state as { count?: number | bigint }).count;
			return typeof count === "bigint" ? Number(count) : (count ?? 0);
		});
	const ops = (op: string, outcome: string) => metricCount(tagged(kvOps, { op, outcome }));
	const durationCount = (op: string) => metricCount(tagged(kvOpDuration, { op }));
	const rows = (op: string, kind: string) => metricCount(tagged(kvRows, { op, kind }));

	const runTraced = <A, E>(effect: Effect.Effect<A, E, Kv>, tracer: Tracer.Tracer) =>
		runtime.runPromise(Effect.provideService(effect, Tracer.Tracer, tracer));

	it("emits a kv.<method> span per call with the namespace attribute", async () => {
		const { tracer, spans } = makeTracer();
		await runTraced(
			eff((kv) => kv.set("t.telm", "k", 1, { scope: GLOBAL })),
			tracer,
		);
		await runTraced(
			eff((kv) => kv.get("t.telm", "k", GLOBAL)),
			tracer,
		);
		const names = spans.map((s) => s.name);
		expect(names).toContain("kv.set");
		expect(names).toContain("kv.get");
		const setSpan = spans.find((s) => s.name === "kv.set");
		expect(setSpan?.attributes.get("kv.namespace")).toBe("t.telm");
		// Keys and values never reach span attributes.
		expect(setSpan?.attributes.has("kv.key")).toBe(false);
		expect(setSpan?.attributes.has("kv.value")).toBe(false);
	});

	it("counts ops by outcome and records duration on success and failure", async () => {
		const [before, errBefore, durBefore] = await Promise.all([
			ops("get", "success"),
			ops("get", "error"),
			durationCount("get"),
		]);
		await run(eff((kv) => kv.set("t.telm-m", "k", 1, { scope: GLOBAL })));
		await run(eff((kv) => kv.get("t.telm-m", "k", GLOBAL)));
		// Invalid namespace → typed KvValidationError → outcome=error.
		await runErr(eff((kv) => kv.get("", "k", GLOBAL)));
		expect(await ops("get", "success")).toBe(before + 1);
		expect(await ops("get", "error")).toBe(errBefore + 1);
		expect(await durationCount("get")).toBe(durBefore + 2);
	});

	it("counts swept rows and listed keys", async () => {
		const sweepBefore = await rows("sweepExpired", "deleted");
		const keysBefore = await rows("keys", "listed");
		await seedRow({ namespace: "t.telmsweep", key: "e", expiresAt: Date.now() - 1 });
		await seedRow({ namespace: "t.telmsweep", key: "live", value: "1" });
		const removed = await run(eff((kv) => kv.sweepExpired()));
		expect(removed).toBeGreaterThanOrEqual(1);
		expect(await rows("sweepExpired", "deleted")).toBe(sweepBefore + removed);
		const keys = await run(eff((kv) => kv.keys("t.telmsweep", GLOBAL)));
		expect(keys).toContain("live");
		expect(await rows("keys", "listed")).toBe(keysBefore + keys.length);
	});

	it("swallows metric-registry failures — ops still succeed", async () => {
		// A registry that throws on any access: recordSafe must keep the
		// write path alive (telemetry is best-effort, never fatal).
		const broken = new Proxy(new Map(), {
			get: () => {
				throw new Error("registry down");
			},
		});
		const entry = await runtime.runPromise(
			Effect.provideService(
				eff((kv) => kv.set("t.telmbroken", "k", 42, { scope: GLOBAL })),
				Metric.MetricRegistry,
				broken as never,
			),
		);
		expect(entry.value).toBe(42);
	});
});
