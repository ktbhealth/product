import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden } from "@ktb/authz";
import { GLOBAL_SCOPE, localeChain, type LocaleChain, type ScopeChain } from "@ktb/i18n";
import { PlatformAdmin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";

import { syncBaseline } from "./baseline.ts";
import { I18nAdmin, type I18nAdminShape } from "./contract.ts";
import {
	I18N_TEST_DDL,
	i18nLocales,
	i18nMessages,
	i18nNamespaces,
	i18nPanelPlugin,
} from "./index.ts";
import {
	I18nRuntime,
	I18nRuntimeLive,
	MAX_CACHE_ENTRIES,
	SEED_RETRY_COOLDOWN_MS,
	STAMP_TTL_MS,
} from "./runtime.ts";
import { requestI18n } from "./service.ts";
import {
	bumpCatalogRevision,
	catalogStamp,
	listLocales,
	listMessageRows,
	listPublishedRows,
} from "./store.ts";

let db: DbClient;

beforeAll(() => {
	db = makeDb(makeD1(I18N_TEST_DDL));
});

describe("syncBaseline", () => {
	it("inserts global published rows and is idempotent", async () => {
		const entries = [
			{ namespace: "app", key: "title", locale: "en", value: "Hello {name}" },
			{ namespace: "app", key: "title", locale: "pt-BR", value: "Olá {name}" },
			{ namespace: "app", key: "bad", locale: "en", value: "<b>markup</b>" },
		];
		const r1 = await syncBaseline(db, entries);
		expect(r1.inserted).toBe(2);
		expect(r1.invalid).toHaveLength(1);

		const r2 = await syncBaseline(db, entries);
		expect(r2.inserted).toBe(0);
		expect(r2.skipped).toBe(2);
	});

	it("batches existence checks and inserts instead of per-entry queries", async () => {
		// Count prepared statements: the old per-entry SELECT+INSERT loop
		// cost ~2 queries per row; the batched sync costs 1 select +
		// ceil(n/64) inserts + 1 namespaces insert.
		const inner = makeD1(I18N_TEST_DDL);
		let prepares = 0;
		const counting = {
			...inner,
			prepare: (q: string) => {
				prepares++;
				return inner.prepare(q);
			},
		};
		const batchDb = makeDb(counting);
		const entries = Array.from({ length: 150 }, (_, i) => ({
			namespace: "batch.ns",
			key: `k${i}`,
			locale: "en",
			value: `Value ${i}`,
		}));
		const r1 = await syncBaseline(batchDb, entries);
		expect(r1.inserted).toBe(150);
		expect(r1.skipped).toBe(0);
		// 1 existence select + 3 chunked inserts (150/64 → 3) + 1
		// revision bump + 1 namespaces insert = 6 statements total.
		expect(prepares).toBe(6);
		const rows = await batchDb.select().from(i18nMessages);
		expect(rows.filter((r) => r.namespace === "batch.ns")).toHaveLength(150);

		// Idempotent re-run: 1 select + 1 namespaces insert, no inserts.
		prepares = 0;
		const r2 = await syncBaseline(batchDb, entries);
		expect(r2.inserted).toBe(0);
		expect(r2.skipped).toBe(150);
		expect(prepares).toBe(2);
	});

	it("rejects entries with invalid ids or oversized values", async () => {
		const r = await syncBaseline(db, [
			{ namespace: "app", key: "has space", locale: "en", value: "x" },
			{ namespace: "app", key: "bad-locale", locale: "en US", value: "x" },
			{ namespace: "app", key: "too-long", locale: "en", value: "x".repeat(60_000) },
		]);
		expect(r.inserted).toBe(0);
		expect(r.invalid).toHaveLength(3);
		const rows = await db.select().from(i18nMessages).where(eq(i18nMessages.key, "has space"));
		expect(rows).toHaveLength(0);
	});

	it("syncBaseline with no entries is a no-op", async () => {
		const r = await syncBaseline(db, []);
		expect(r).toEqual({ inserted: 0, skipped: 0, invalid: [] });
	});

	it("skips duplicate tuples within one batch — first occurrence wins", async () => {
		const r = await syncBaseline(db, [
			{ namespace: "dup.ns", key: "k", locale: "en", value: "first" },
			{ namespace: "dup.ns", key: "k", locale: "en", value: "second" },
		]);
		expect(r.inserted).toBe(1);
		expect(r.skipped).toBe(1);
		const rows = await db
			.select()
			.from(i18nMessages)
			.where(and(eq(i18nMessages.namespace, "dup.ns"), eq(i18nMessages.key, "k")));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.value).toBe("first");
	});
});

describe("store", () => {
	it("listPublishedRows returns only published rows in scope+locale", async () => {
		const rows = await listPublishedRows(db, {
			locales: ["en"],
			scopes: GLOBAL_SCOPE.scopes,
		});
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(rows.every((r) => r.status === "published")).toBe(true);
	});

	it("listPublishedRows excludes draft rows", async () => {
		await db.insert(i18nMessages).values({
			namespace: "app",
			key: "draft-only",
			locale: "en",
			scope: "global",
			scopeId: "",
			kind: "text",
			value: "",
			draftValue: "staged",
			status: "draft",
			params: [],
			version: 1,
		});
		const rows = await listPublishedRows(db, {
			locales: ["en"],
			scopes: GLOBAL_SCOPE.scopes,
		});
		expect(rows.find((r) => r.key === "draft-only")).toBeUndefined();
	});

	it("catalogStamp is the single-row revision — moved only by bumpCatalogRevision", async () => {
		const s1 = await catalogStamp(db);
		// Direct message writes do NOT move the stamp — the revision
		// counter is the contract; writers bump it explicitly.
		await db.insert(i18nMessages).values({
			namespace: "app",
			key: "stamp-test",
			locale: "en",
			scope: "global",
			scopeId: "",
			kind: "text",
			value: "x",
			status: "published",
			params: [],
			version: 1,
		});
		expect(await catalogStamp(db)).toBe(s1);
		await bumpCatalogRevision(db);
		expect(await catalogStamp(db)).not.toBe(s1);
	});

	it("bumpCatalogRevision is monotonic across repeated bumps", async () => {
		const stamps = new Set<string>();
		for (let i = 0; i < 3; i++) {
			stamps.add(await catalogStamp(db));
			await bumpCatalogRevision(db);
		}
		stamps.add(await catalogStamp(db));
		expect(stamps.size).toBe(4);
	});

	it("listLocales reads i18n_locales", async () => {
		const locales = await listLocales(db);
		expect(Array.isArray(locales)).toBe(true);
	});

	it("listMessageRows filters by scope + scopeId (panel matrix)", async () => {
		await db.insert(i18nMessages).values({
			namespace: "app",
			key: "scoped",
			locale: "en",
			scope: "tenant",
			scopeId: "t-9",
			kind: "text",
			value: "Tenant copy",
			status: "published",
			params: [],
			version: 1,
		});
		const hit = await listMessageRows(db, {
			namespace: "app",
			scope: "tenant",
			scopeId: "t-9",
		});
		expect(hit.map((r) => r.key)).toContain("scoped");
		const miss = await listMessageRows(db, {
			namespace: "app",
			scope: "tenant",
			scopeId: "other",
		});
		expect(miss.find((r) => r.key === "scoped")).toBeUndefined();
	});

	it("listMessageRows filters by locale + status (panel matrix)", async () => {
		await db.insert(i18nMessages).values([
			{
				namespace: "flt.ns",
				key: "k",
				locale: "en",
				scope: "global",
				scopeId: "",
				kind: "text",
				value: "published",
				status: "published",
				params: [],
				version: 1,
			},
			{
				namespace: "flt.ns",
				key: "k-draft",
				locale: "en",
				scope: "global",
				scopeId: "",
				kind: "text",
				value: "draft",
				status: "draft",
				params: [],
				version: 1,
			},
			{
				namespace: "flt.ns",
				key: "k",
				locale: "pt-BR",
				scope: "global",
				scopeId: "",
				kind: "text",
				value: "publicado",
				status: "published",
				params: [],
				version: 1,
			},
		]);
		const drafts = await listMessageRows(db, {
			namespace: "flt.ns",
			locale: "en",
			status: "draft",
		});
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.value).toBe("draft");
		const pt = await listMessageRows(db, {
			namespace: "flt.ns",
			locale: "pt-BR",
			status: "published",
		});
		expect(pt).toHaveLength(1);
		expect(pt[0]?.value).toBe("publicado");
	});

	it("listMessageRows with no filter returns every row", async () => {
		const all = await listMessageRows(db);
		expect(all.length).toBeGreaterThan(0);
		// A partial filter (no locale) still constrains by namespace.
		const ns = await listMessageRows(db, { namespace: "flt.ns" });
		expect(ns.every((r) => r.namespace === "flt.ns")).toBe(true);
		expect(ns.length).toBeGreaterThan(0);
	});

	it("catalogStamp reads r0 before the first revision bump", async () => {
		const fresh = makeDb(makeD1(I18N_TEST_DDL));
		expect(await catalogStamp(fresh)).toBe("r0");
	});
});

describe("I18nRuntime cache", () => {
	// Built lazily — `db` is only assigned in beforeAll.
	const makeRuntime = () =>
		ManagedRuntime.make(I18nRuntimeLive.pipe(Layer.provide(Layer.succeed(Db, db))));

	it("serves t() through the cached catalog", async () => {
		const runtime = makeRuntime();
		const i18n = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return requestI18n(rt, GLOBAL_SCOPE, localeChain(["en"], "en") satisfies LocaleChain);
			}),
		);
		const text = await runtime.runPromise(i18n.t("app.title", { name: "Ana" }));
		expect(text).toBe("Hello Ana");
	});

	it("falls back to namespace.key sentinel for missing keys", async () => {
		const runtime = makeRuntime();
		const i18n = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return requestI18n(rt, GLOBAL_SCOPE, localeChain(["en"], "en"));
			}),
		);
		const text = await runtime.runPromise(i18n.t("app.does-not-exist"));
		expect(text).toBe("app.does-not-exist");
	});

	it("t() survives hostile missing keys (telemetry sanitization path)", async () => {
		const runtime = makeRuntime();
		const i18n = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return requestI18n(rt, GLOBAL_SCOPE, localeChain(["en"], "en"));
			}),
		);
		// Control chars + overlong key: logMissingKey must sanitize
		// rather than throw or leak raw input into logs.
		const text = await runtime.runPromise(i18n.t(`app.${"k".repeat(500)}\n\x00evil`));
		expect(text).toContain("app.");
	});

	it("t() resolves dotted namespaces and dot-pathed keys", async () => {
		await db.insert(i18nMessages).values({
			namespace: "eval.credentials",
			key: "sections.list.title",
			locale: "en",
			scope: "global",
			scopeId: "",
			kind: "text",
			value: "Credentials {count, number}",
			status: "published",
			params: [{ name: "count", hint: "number" }],
			version: 1,
		});
		const runtime = makeRuntime();
		const i18n = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return requestI18n(rt, GLOBAL_SCOPE, localeChain(["en"], "en"));
			}),
		);
		// Longest-prefix namespace split: eval.credentials + sections.list.title.
		const text = await runtime.runPromise(
			i18n.t("eval.credentials.sections.list.title", { count: 2 }),
		);
		expect(text).toBe("Credentials 2");
		const params = await runtime.runPromise(
			i18n.paramsFor("eval.credentials", "sections.list.title"),
		);
		expect(params).toEqual([{ name: "count", hint: "number" }]);
		// Miss → manifest contract, then empty.
		expect(await runtime.runPromise(i18n.paramsFor("eval.credentials", "missing"))).toEqual([]);
		expect(await runtime.runPromise(i18n.paramsFor("no.such.ns", "k"))).toEqual([]);
	});

	it("t() pseudo-localizes when the locale chain leads with qps", async () => {
		const runtime = makeRuntime();
		const i18n = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return requestI18n(rt, GLOBAL_SCOPE, localeChain(["qps", "en"], "en"));
			}),
		);
		const text = await runtime.runPromise(i18n.t("app.title", { name: "Ana" }));
		// ⟦accented template ··padding⟧ with params still rendered.
		expect(text.startsWith("⟦")).toBe(true);
		expect(text.endsWith("⟧")).toBe(true);
		expect(text).toContain("Ana");
	});

	it("invalidate forces reload after a write", async () => {
		const runtime = makeRuntime();
		const { i18n, rt } = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return { i18n: requestI18n(rt, GLOBAL_SCOPE, localeChain(["en"], "en")), rt };
			}),
		);
		await runtime.runPromise(i18n.t("app.title"));
		await db
			.update(i18nMessages)
			.set({ value: "Updated {name}", version: 2 })
			.where(
				and(
					eq(i18nMessages.namespace, "app"),
					eq(i18nMessages.key, "title"),
					eq(i18nMessages.locale, "en"),
				),
			);
		await runtime.runPromise(rt.invalidate());
		const text = await runtime.runPromise(i18n.t("app.title", { name: "Bo" }));
		expect(text).toBe("Updated Bo");
	});

	it("does not collide cache entries across chains with separator chars", async () => {
		// The old "|"/","-joined cacheKey mapped BOTH of these chains to
		// "tenant:a|portal:b|global:c" — the second call would have been
		// served the first chain's catalog.
		await db.insert(i18nMessages).values([
			{
				namespace: "collide",
				key: "k",
				locale: "c",
				scope: "tenant",
				scopeId: "a|portal:b",
				kind: "text",
				value: "tenant-copy",
				status: "published",
				params: [],
				version: 1,
			},
			{
				namespace: "collide",
				key: "k",
				locale: "c",
				scope: "portal",
				scopeId: "b",
				kind: "text",
				value: "portal-copy",
				status: "published",
				params: [],
				version: 1,
			},
		]);
		const runtime = makeRuntime();
		const rt = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* I18nRuntime;
			}),
		);
		const locales: LocaleChain = { locales: ["c"], defaultLocale: "c" };
		const chainA: ScopeChain = {
			scopes: [
				{ scope: "tenant", scopeId: "a|portal:b" },
				{ scope: "global", scopeId: "" },
			],
		};
		const chainB: ScopeChain = {
			scopes: [
				{ scope: "tenant", scopeId: "a" },
				{ scope: "portal", scopeId: "b" },
				{ scope: "global", scopeId: "" },
			],
		};
		const i18nA = requestI18n(rt, chainA, locales);
		const i18nB = requestI18n(rt, chainB, locales);
		expect(await runtime.runPromise(i18nA.t("collide.k"))).toBe("tenant-copy");
		expect(await runtime.runPromise(i18nB.t("collide.k"))).toBe("portal-copy");
	});

	it("evicts the oldest entries beyond MAX_CACHE_ENTRIES", async () => {
		const runtime = makeRuntime();
		const rt = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* I18nRuntime;
			}),
		);
		const lc = (l: string): LocaleChain => ({ locales: [l], defaultLocale: l });
		// Fill past the cap with distinct locale chains (0..MAX+7).
		for (let i = 0; i < MAX_CACHE_ENTRIES + 8; i++) {
			await runtime.runPromise(rt.catalogFor(GLOBAL_SCOPE, lc(`fill${i}`)));
		}
		// Written AFTER the fill: only an evicted (re-loaded) chain sees it.
		await db.insert(i18nMessages).values([
			{
				namespace: "evict",
				key: "k",
				locale: "fill0",
				scope: "global",
				scopeId: "",
				kind: "text",
				value: "fresh",
				status: "published",
				params: [],
				version: 1,
			},
			{
				namespace: "evict",
				key: "k",
				locale: `fill${MAX_CACHE_ENTRIES + 7}`,
				scope: "global",
				scopeId: "",
				kind: "text",
				value: "hidden",
				status: "published",
				params: [],
				version: 1,
			},
		]);
		const rowKey = (l: string) => JSON.stringify(["evict", "k", l, "global", ""]);
		// fill0 was the oldest → evicted → reload sees the new row.
		const evictedIdx = await runtime.runPromise(rt.catalogFor(GLOBAL_SCOPE, lc("fill0")));
		expect(evictedIdx.get(rowKey("fill0"))?.value).toBe("fresh");
		// The newest chain is still cached within TTL → stale index.
		const retainedIdx = await runtime.runPromise(
			rt.catalogFor(GLOBAL_SCOPE, lc(`fill${MAX_CACHE_ENTRIES + 7}`)),
		);
		expect(retainedIdx.get(rowKey(`fill${MAX_CACHE_ENTRIES + 7}`))).toBeUndefined();
	});

	it("re-checks the stamp after TTL and serves the cached index when unchanged", async () => {
		const runtime = makeRuntime();
		const rt = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* I18nRuntime;
			}),
		);
		const locales = localeChain(["en"], "en");
		const first = await runtime.runPromise(rt.catalogFor(GLOBAL_SCOPE, locales));
		// Jump past the TTL: the stamp re-read finds no change, so the
		// SAME index object is served with a refreshed loadedAt.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + STAMP_TTL_MS + 1);
		try {
			const second = await runtime.runPromise(rt.catalogFor(GLOBAL_SCOPE, locales));
			expect(second).toBe(first);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("reloads after TTL when the catalog stamp changed", async () => {
		const runtime = makeRuntime();
		const rt = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* I18nRuntime;
			}),
		);
		const locales = localeChain(["en"], "en");
		const first = await runtime.runPromise(rt.catalogFor(GLOBAL_SCOPE, locales));
		// A write + revision bump moves the stamp → the expired-TTL
		// re-check must reload instead of serving the stale index.
		await db.insert(i18nMessages).values({
			namespace: "stamp-change",
			key: "k",
			locale: "en",
			scope: "global",
			scopeId: "",
			kind: "text",
			value: "fresh",
			status: "published",
			params: [],
			version: 1,
		});
		await bumpCatalogRevision(db);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + STAMP_TTL_MS + 1);
		try {
			const second = await runtime.runPromise(rt.catalogFor(GLOBAL_SCOPE, locales));
			expect(second).not.toBe(first);
			expect(second.get(JSON.stringify(["stamp-change", "k", "en", "global", ""]))?.value).toBe(
				"fresh",
			);
		} finally {
			nowSpy.mockRestore();
		}
	});
});

describe("runtime auto-seed", () => {
	it("seeds the qps locale and baseline namespaces on an empty database", async () => {
		const fresh = makeDb(makeD1(I18N_TEST_DDL));
		const runtime = ManagedRuntime.make(
			I18nRuntimeLive.pipe(Layer.provide(Layer.succeed(Db, fresh))),
		);
		await runtime.runPromise(Effect.void);

		const locales = await fresh.select().from(i18nLocales);
		// Real locales seed enabled; the qps pseudo-locale seeds
		// DISABLED — it's a QA opt-in admins enable from the panel.
		for (const code of ["en", "pt-BR", "es"]) {
			expect(locales.find((l) => l.code === code)?.enabled).toBe(true);
		}
		expect(locales.find((l) => l.code === "qps")?.enabled).toBe(false);

		// The baseline loads lazily from the "@ktb/i18n/baseline.gen"
		// subpath (P-088) — assert against whatever it exports.
		const core = (await import("@ktb/i18n/baseline.gen")) as {
			I18N_BASELINE: readonly { namespace: string }[];
		};
		const expected = new Set(core.I18N_BASELINE.map((e) => e.namespace)).size;
		const namespaces = await fresh.select().from(i18nNamespaces);
		expect(namespaces).toHaveLength(expected);
	});

	it("skips baseline on a populated database and survives seed failure", async () => {
		// Shared `db` already has namespaces → the empty-check no-ops.
		const before = await db.select().from(i18nNamespaces);
		const runtime = ManagedRuntime.make(I18nRuntimeLive.pipe(Layer.provide(Layer.succeed(Db, db))));
		await runtime.runPromise(Effect.void);
		expect(await db.select().from(i18nNamespaces)).toHaveLength(before.length);

		// A db whose i18n_locales insert rejects: the seed failure is
		// logged, the layer still builds.
		const broken = {
			insert: () => ({
				values: () => ({
					onConflictDoNothing: () => Promise.reject(new Error("no tables")),
				}),
			}),
		} as unknown as DbClient;
		const rt2 = ManagedRuntime.make(I18nRuntimeLive.pipe(Layer.provide(Layer.succeed(Db, broken))));
		await rt2.runPromise(Effect.void);
	});

	it("retries the layer-build seed through transient failures", async () => {
		const inner = makeDb(makeD1(I18N_TEST_DDL));
		// Fail the first two seed attempts (locales insert rejects), then
		// delegate — the exponential-backoff retry must still seed.
		let failures = 2;
		const flaky = new Proxy(inner, {
			get(target, prop) {
				if (prop === "insert") {
					return (...args: unknown[]) => {
						if (failures > 0) {
							failures--;
							return {
								values: () => ({
									onConflictDoNothing: () => Promise.reject(new Error("transient D1")),
								}),
							};
						}
						return (target.insert as (...a: unknown[]) => unknown)(...args);
					};
				}
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		}) as unknown as DbClient;
		const runtime = ManagedRuntime.make(
			I18nRuntimeLive.pipe(Layer.provide(Layer.succeed(Db, flaky))),
		);
		await runtime.runPromise(Effect.void);
		expect(await inner.select().from(i18nLocales)).not.toHaveLength(0);
	});

	it("re-seeds lazily via catalogFor after the build seed exhausts retries", async () => {
		const inner = makeDb(makeD1(I18N_TEST_DDL));
		// 1 initial attempt + SEED_RETRY_TIMES retries, one insert call
		// each — exhaust them all at layer build.
		let failures = 4;
		const flaky = new Proxy(inner, {
			get(target, prop) {
				if (prop === "insert") {
					return (...args: unknown[]) => {
						if (failures > 0) {
							failures--;
							return {
								values: () => ({
									onConflictDoNothing: () => Promise.reject(new Error("transient D1")),
								}),
							};
						}
						return (target.insert as (...a: unknown[]) => unknown)(...args);
					};
				}
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		}) as unknown as DbClient;
		const runtime = ManagedRuntime.make(
			I18nRuntimeLive.pipe(Layer.provide(Layer.succeed(Db, flaky))),
		);
		const rt = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* I18nRuntime;
			}),
		);
		// Build-time seed failed every attempt — isolate starts empty.
		expect(await inner.select().from(i18nLocales)).toHaveLength(0);

		// Jump past the re-seed cooldown: the next catalog load
		// re-attempts the seed BEFORE reading the stamp, so this same
		// call already serves the seeded catalog.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + SEED_RETRY_COOLDOWN_MS + 1);
		try {
			const index = await runtime.runPromise(
				rt.catalogFor(GLOBAL_SCOPE, localeChain(["en"], "en")),
			);
			expect(index.size).toBeGreaterThan(0);
		} finally {
			nowSpy.mockRestore();
		}
		expect(await inner.select().from(i18nLocales)).not.toHaveLength(0);
	});
});

describe("constants", () => {
	it("STAMP_TTL_MS is ~15s", () => {
		expect(STAMP_TTL_MS).toBeGreaterThanOrEqual(10_000);
		expect(STAMP_TTL_MS).toBeLessThanOrEqual(30_000);
	});
	it("scope helpers produce chains", () => {
		expect(GLOBAL_SCOPE.scopes).toHaveLength(1);
	});
});

describe("i18nPanelPlugin page", () => {
	const page = i18nPanelPlugin.panel?.pages[0];

	const fakeAdmin = (over: Partial<I18nAdminShape> = {}): I18nAdminShape => ({
		namespaces: () => Effect.succeed([]),
		locales: () => Effect.succeed([]),
		messages: () => Effect.succeed([]),
		saveDraft: () => Effect.void,
		publish: () => Effect.void,
		discardDraft: () => Effect.void,
		setLocaleEnabled: () => Effect.void,
		exportNamespace: () => Effect.succeed({ version: 1 as const, namespace: "app", messages: {} }),
		importNamespace: () => Effect.succeed({ imported: 0 }),
		...over,
	});

	const adminGate = (ok: boolean) => ({
		isAdmin: () => Effect.succeed(ok),
		requireAdmin: () => (ok ? Effect.void : Effect.fail(new Forbidden({ path: "/platform/i18n" }))),
	});

	it("guard passes on an rbac grant without consulting the admin gate", async () => {
		const guard = page?.guard;
		expect(guard).toBeDefined();
		const requireAdmin = vi.fn(() => Effect.fail(new Forbidden({ path: "x" })));
		const result = await Effect.runPromise(
			guard!().pipe(
				Effect.provideService(Permissions, {
					can: () => Effect.succeed(true),
				} as never),
				Effect.provideService(PlatformAdmin, {
					isAdmin: () => Effect.succeed(false),
					requireAdmin,
				}),
			),
		);
		expect(result).toBe(true);
		expect(requireAdmin).not.toHaveBeenCalled();
	});

	it("guard falls back to the admin allowlist when rbac denies", async () => {
		const guard = page?.guard;
		const allowed = await Effect.runPromise(
			guard!().pipe(
				Effect.provideService(Permissions, {
					can: () => Effect.succeed(false),
				} as never),
				Effect.provideService(PlatformAdmin, adminGate(true)),
			),
		);
		expect(allowed).toBe(true);
		const denied = await Effect.runPromise(
			guard!().pipe(
				Effect.provideService(Permissions, {
					can: () => Effect.succeed(false),
				} as never),
				Effect.provideService(PlatformAdmin, adminGate(false)),
			),
		);
		expect(denied).toBe(false);
	});

	it("guard works without the Permissions service (admin gate only)", async () => {
		const guard = page?.guard;
		const allowed = await Effect.runPromise(
			guard!().pipe(Effect.provideService(PlatformAdmin, adminGate(true))),
		);
		expect(allowed).toBe(true);
		const denied = await Effect.runPromise(
			guard!().pipe(Effect.provideService(PlatformAdmin, adminGate(false))),
		);
		expect(denied).toBe(false);
	});

	it("loader returns namespaces + locales from I18nAdmin", async () => {
		const loader = page?.loader;
		expect(loader).toBeDefined();
		const admin = fakeAdmin({
			namespaces: () =>
				Effect.succeed([
					{ namespace: "app", pluginId: "host", defaultLocale: "en", messageCount: 3 },
				]),
			locales: () =>
				Effect.succeed([{ code: "en", endonym: "English", fallbacks: [], enabled: true }]),
		});
		const out = await Effect.runPromise(loader!().pipe(Effect.provideService(I18nAdmin, admin)));
		expect(out.namespaces).toHaveLength(1);
		expect(out.locales).toHaveLength(1);
	});

	it("loader degrades to empty lists on Forbidden", async () => {
		const loader = page?.loader;
		const admin = fakeAdmin({
			namespaces: () => Effect.fail(new Forbidden({ path: "i18n.namespaces" })),
		});
		const out = await Effect.runPromise(loader!().pipe(Effect.provideService(I18nAdmin, admin)));
		expect(out).toEqual({ namespaces: [], locales: [] });
	});
});
