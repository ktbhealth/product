import { beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { GLOBAL_SCOPE, portalScope } from "@ktb/i18n";

import { I18N_TEST_DDL, i18nLocales, i18nMessages } from "./index.ts";
import { resolveRequestI18n } from "./request.ts";
import { I18nRuntime, I18nRuntimeLive } from "./runtime.ts";
import { syncBaseline } from "./baseline.ts";

let db: DbClient;

beforeAll(async () => {
	db = makeDb(makeD1(I18N_TEST_DDL));
	await syncBaseline(db, [
		{ namespace: "app", key: "hi", locale: "en", value: "Hello" },
		{ namespace: "app", key: "hi", locale: "pt-BR", value: "Olá" },
	]);
	await db.insert(i18nLocales).values([
		{ code: "en", endonym: "English", fallbacks: [], enabled: true },
		{ code: "pt-BR", endonym: "Português", fallbacks: ["en"], enabled: true },
		{ code: "es", endonym: "Español", fallbacks: ["en"], enabled: false },
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
