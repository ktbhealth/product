import { beforeAll, describe, expect, it } from "vitest";

import { makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import * as Effect from "effect/Effect";

import { GLOBAL_SCOPE, localeChain, tenantScope } from "@ktb/i18n";

import { syncBaseline } from "./baseline.ts";
import { i18nMessages } from "./index.ts";
import { catalogSlice, stableSlice } from "./slice.ts";

let db: DbClient;

beforeAll(async () => {
	db = makeDb(makeTestD1());
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

	it("pseudo-localizes slice values when the chain leads with qps", async () => {
		const slice = await Effect.runPromise(
			catalogSlice(db, {
				namespaces: ["app"],
				scopeChain: GLOBAL_SCOPE,
				locales: localeChain(["qps", "en"], "en"),
			}),
		);
		// qps has no authored rows — the en template is resolved, then
		// pseudo-localized (accented + ⟦⟧ wrapped).
		expect(slice["app.title"]).toMatch(/^⟦.+⟧$/);
	});

	it("skips published rows the scope chain cannot resolve", async () => {
		// A global row carrying a stray scopeId is visible to
		// listPublishedRows (the global scope cond ignores scopeId) but
		// unresolvable — resolveRow probes scopeId "" and misses.
		await db.insert(i18nMessages).values({
			namespace: "app",
			key: "odd-scope",
			locale: "en",
			scope: "global",
			scopeId: "stray",
			kind: "text",
			value: "stray",
			status: "published",
			params: [],
			version: 1,
		});
		const slice = await Effect.runPromise(
			catalogSlice(db, {
				namespaces: ["app"],
				scopeChain: GLOBAL_SCOPE,
				locales: localeChain(["en"], "en"),
			}),
		);
		expect(slice["app.odd-scope"]).toBeUndefined();
		expect(slice["app.title"]).toBe("App title");
	});

	it("stableSlice sorts keys", () => {
		const s = stableSlice({ "b.k": "1", "a.k": "2" });
		expect(Object.keys(s)).toEqual(["a.k", "b.k"]);
	});
});
