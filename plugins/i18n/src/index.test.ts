import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { GLOBAL_SCOPE, localeChain, type LocaleChain, type ScopeChain } from "@ktb/i18n";

import { syncBaseline } from "./baseline.ts";
import { I18N_TEST_DDL, i18nLocales, i18nMessages, i18nNamespaces } from "./index.ts";
import { I18nRuntime, I18nRuntimeLive, MAX_CACHE_ENTRIES, STAMP_TTL_MS } from "./runtime.ts";
import { requestI18n } from "./service.ts";
import { catalogStamp, listLocales, listMessageRows, listPublishedRows } from "./store.ts";

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
		// namespaces insert = 5 statements total.
		expect(prepares).toBe(5);
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

	it("catalogStamp changes on write", async () => {
		const s1 = await catalogStamp(db);
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
		const s2 = await catalogStamp(db);
		expect(s2).not.toBe(s1);
	});

	it("catalogStamp includes max(updated_at) — timestamp-only writes move it", async () => {
		const s1 = await catalogStamp(db);
		// Bump updated_at on a published row WITHOUT touching version —
		// count+versionSum stay frozen, only the timestamp component moves.
		await db
			.update(i18nMessages)
			.set({ updatedAt: new Date(Date.now() + 60_000) })
			.where(
				and(
					eq(i18nMessages.namespace, "app"),
					eq(i18nMessages.key, "title"),
					eq(i18nMessages.status, "published"),
				),
			);
		const s2 = await catalogStamp(db);
		expect(s2).not.toBe(s1);
		// Stamp shape: count:versionSum:maxUpdatedAt.
		expect(s2.split(":")).toHaveLength(3);
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

		// I18N_BASELINE lands with the code-catalog extraction — assert
		// against whatever it exports (empty until then).
		const core = (await import("@ktb/i18n")) as {
			I18N_BASELINE?: readonly { namespace: string }[];
		};
		const expected = new Set((core.I18N_BASELINE ?? []).map((e) => e.namespace)).size;
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
