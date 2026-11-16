import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { GLOBAL_SCOPE, localeChain, type LocaleChain } from "@ktb/i18n";

import { syncBaseline } from "./baseline.ts";
import { I18N_TEST_DDL, i18nMessages } from "./index.ts";
import { I18nRuntime, I18nRuntimeLive, STAMP_TTL_MS } from "./runtime.ts";
import { requestI18n } from "./service.ts";
import { catalogStamp, listLocales, listPublishedRows } from "./store.ts";

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

	it("listLocales reads i18n_locales", async () => {
		const locales = await listLocales(db);
		expect(Array.isArray(locales)).toBe(true);
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
