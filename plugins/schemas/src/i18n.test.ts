import { describe, expect, it } from "vitest";

import { i18nMessagesFor, isSchemasLocale, SCHEMAS_LOCALES, schemasMessages } from "./i18n.ts";

describe("schemas i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = schemasMessages("en");
		for (const locale of SCHEMAS_LOCALES) {
			const catalog = schemasMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(schemasMessages("de")).toBe(schemasMessages("en"));
		expect(schemasMessages(undefined)).toBe(schemasMessages("en"));
		expect(schemasMessages("")).toBe(schemasMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(schemasMessages("en").deleteBody("q")).toContain("q");
		expect(schemasMessages("pt-BR").deleteBody("q")).toContain("q");
		expect(schemasMessages("es").deleteBody("q")).toContain("q");
	});

	it("isSchemasLocale matches declared locales only", () => {
		expect(isSchemasLocale("en")).toBe(true);
		expect(isSchemasLocale("pt-BR")).toBe(true);
		expect(isSchemasLocale("es")).toBe(true);
		expect(isSchemasLocale("en-US")).toBe(false);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as schemasMessages, with base fallback", () => {
		for (const locale of SCHEMAS_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(schemasMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(schemasMessages("en"));
		expect(i18nMessagesFor("")).toBe(schemasMessages("en"));
	});
});
