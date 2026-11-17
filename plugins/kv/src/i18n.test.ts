import { describe, expect, it } from "vitest";

import { i18nMessagesFor, isKvLocale, kvMessages, KV_LOCALES } from "./i18n.ts";

describe("kv i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = kvMessages("en");
		for (const locale of KV_LOCALES) {
			const catalog = kvMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(kvMessages("de")).toBe(kvMessages("en"));
		expect(kvMessages(undefined)).toBe(kvMessages("en"));
		expect(kvMessages("")).toBe(kvMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		for (const locale of KV_LOCALES) {
			const catalog = kvMessages(locale);
			expect(catalog.deleteBody("k")).toContain("k");
			expect(catalog.scopeTenant(3)).toContain("3");
			expect(catalog.scopeOwner("u1")).toContain("u1");
			expect(catalog.totalCount(2)).toContain("2");
			expect(catalog.pageInfo(1, 3)).toContain("1");
			expect(catalog.expiresIn(30_000)).toContain("30");
			expect(catalog.expiresIn(3_600_000)).toMatch(/\d/);
			expect(catalog.expiresIn(200_000_000)).toMatch(/\d/);
			expect(catalog.expiresIn(90_000)).toMatch(/\d/);
			expect(catalog.totalCount(1)).toContain("1");
		}
	});

	it("expiresIn picks the right unit bucket", () => {
		expect(kvMessages("en").expiresIn(5_000)).toBe("in 5s");
		expect(kvMessages("en").expiresIn(90_000)).toBe("in 2m");
		expect(kvMessages("en").expiresIn(7_200_000)).toBe("in 2h");
		expect(kvMessages("en").expiresIn(200_000_000)).toBe("in 3d");
		expect(kvMessages("en").expiresIn(-1000)).toBe("in 0s");
	});

	it("isKvLocale matches declared locales only", () => {
		expect(isKvLocale("en")).toBe(true);
		expect(isKvLocale("pt-BR")).toBe(true);
		expect(isKvLocale("es")).toBe(true);
		expect(isKvLocale("en-US")).toBe(false);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as kvMessages, with base fallback", () => {
		for (const locale of KV_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(kvMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(kvMessages("en"));
		expect(i18nMessagesFor("")).toBe(kvMessages("en"));
	});
});
