import { beforeAll, describe, expect, it } from "vitest";

import { makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";

import { GLOBAL_SCOPE, localeChain, tenantScope } from "@ktb/i18n";

import { syncBaseline } from "./baseline.ts";
import { I18N_TEST_DDL, i18nMessages } from "./index.ts";
import { catalogSlice, stableSlice } from "./slice.ts";

let db: DbClient;

beforeAll(async () => {
	db = makeDb(makeD1(I18N_TEST_DDL));
	await syncBaseline(db, [
		{ namespace: "app", key: "title", locale: "en", value: "App title" },
		{ namespace: "app", key: "title", locale: "pt-BR", value: "Título" },
		{
			namespace: "patients",
			key: "list",
			locale: "en",
			value: "Patients {count, plural, one {#} other {#}}",
		},
		{ namespace: "other", key: "x", locale: "en", value: "Other ns" },
	]);
	await db.insert(i18nMessages).values({
		namespace: "app",
		key: "title",
		locale: "en",
		scope: "tenant",
		scopeId: "t1",
		kind: "text",
		value: "Tenant title",
		status: "published",
		params: [],
		version: 1,
	});
});

describe("catalogSlice", () => {
	it("resolves only requested namespaces, scope+locale applied", async () => {
		const slice = await Effect.runPromise(
			catalogSlice(db, {
				namespaces: ["app"],
				scopeChain: GLOBAL_SCOPE,
				locales: localeChain(["pt-BR"], "en"),
			}),
		);
		expect(slice["app.title"]).toBe("Título");
		expect(slice["patients.list"]).toBeUndefined();
		expect(slice["other.x"]).toBeUndefined();
	});

	it("tenant scope wins inside the slice", async () => {
		const slice = await Effect.runPromise(
			catalogSlice(db, {
				namespaces: ["app"],
				scopeChain: tenantScope("t1"),
				locales: localeChain(["en"], "en"),
			}),
		);
		expect(slice["app.title"]).toBe("Tenant title");
	});

	it("stableSlice sorts keys", () => {
		const s = stableSlice({ "b.k": "1", "a.k": "2" });
		expect(Object.keys(s)).toEqual(["a.k", "b.k"]);
	});
});
