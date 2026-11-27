import { beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { GLOBAL_SCOPE, portalScope } from "@ktb/i18n";

import { i18nLocales, i18nMessages } from "./index.ts";
import { resolveRequestI18n } from "./request.ts";
import { I18nRuntime, I18nRuntimeLive } from "./runtime.ts";
import { syncBaseline } from "./baseline.ts";

let db: DbClient;

beforeAll(async () => {
	db = makeDb(makeTestD1());
	await syncBaseline(db, [
		{ namespace: "app", key: "hi", locale: "en", value: "Hello" },
		{ namespace: "app", key: "hi", locale: "pt-BR", value: "Olá" },
	]);
	await db.insert(i18nLocales).values([
		{ code: "en", endonym: "English", fallbacks: [], enabled: true },
		{ code: "pt-BR", endonym: "Português", fallbacks: ["en"], enabled: true },
		{ code: "es", endonym: "Español", fallbacks: ["en"], enabled: false },
		// qps seeds DISABLED (QA opt-in) — enable it here the way an
		// admin would via the panel before exercising the pseudo path.
		{ code: "qps", endonym: "Pseudo (QA)", fallbacks: ["en"], enabled: true },
	]);
});

const makeRuntime = () =>
	ManagedRuntime.make(I18nRuntimeLive.pipe(Layer.provide(Layer.succeed(Db, db))));

describe("resolveRequestI18n", () => {
	it("resolves an enabled requested locale end-to-end", async () => {
		const runtime = makeRuntime();
		const { i18n, locales } = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return yield* resolveRequestI18n(rt, db, {
					requestedLocale: "pt-BR",
					scopeChain: GLOBAL_SCOPE,
				});
			}),
		);
		expect(locales.locales).toEqual(["pt-BR", "en"]);
		const text = await runtime.runPromise(i18n.t("app.hi"));
		expect(text).toBe("Olá");
	});

	it("disabled locale falls back to default", async () => {
		const runtime = makeRuntime();
		const { locales } = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return yield* resolveRequestI18n(rt, db, {
					requestedLocale: "es",
					scopeChain: GLOBAL_SCOPE,
				});
			}),
		);
		expect(locales.locales).toEqual(["en"]);
	});

	it("qps pseudo-locale resolves and pseudo-localizes t()", async () => {
		// The test seeds the qps locale row enabled (admin opt-in); the
		// runtime auto-seed leaves it untouched via onConflictDoNothing.
		// Requesting it yields [qps, en] and t() renders the
		// accented/bracketed copy.
		const runtime = makeRuntime();
		const { i18n, locales } = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return yield* resolveRequestI18n(rt, db, {
					requestedLocale: "qps",
					scopeChain: GLOBAL_SCOPE,
				});
			}),
		);
		expect(locales.locales[0]).toBe("qps");
		const text = await runtime.runPromise(i18n.t("app.hi"));
		expect(text.startsWith("⟦")).toBe(true);
	});

	it("scoped chain resolves tenant override", async () => {
		await db.insert(i18nMessages).values({
			namespace: "app",
			key: "hi",
			locale: "en",
			scope: "tenant",
			scopeId: "t1",
			kind: "text",
			value: "Tenant hello",
			status: "published",
			params: [],
			version: 1,
		});
		const runtime = makeRuntime();
		const { i18n } = await runtime.runPromise(
			Effect.gen(function* () {
				const rt = yield* I18nRuntime;
				return yield* resolveRequestI18n(rt, db, {
					scopeChain: portalScope("t1", "p1"),
				});
			}),
		);
		const text = await runtime.runPromise(i18n.t("app.hi"));
		expect(text).toBe("Tenant hello");
	});
});
