import { describe, expect, it } from "vitest";

import { i18nMessagesFor, isPagesLocale, pagesMessages, PAGES_LOCALES } from "./i18n.ts";

describe("pages i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = pagesMessages("en");
		for (const locale of PAGES_LOCALES) {
			const catalog = pagesMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(pagesMessages("de")).toBe(pagesMessages("en"));
		expect(pagesMessages(undefined)).toBe(pagesMessages("en"));
		expect(pagesMessages("")).toBe(pagesMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(pagesMessages("en").deleteBody("/x")).toContain("/x");
		expect(pagesMessages("pt-BR").deleteBody("/x")).toContain("/x");
		expect(pagesMessages("es").deleteBody("/x")).toContain("/x");
	});

	it("isPagesLocale matches declared locales only", () => {
		expect(isPagesLocale("en")).toBe(true);
		expect(isPagesLocale("pt-BR")).toBe(true);
		expect(isPagesLocale("es")).toBe(true);
		expect(isPagesLocale("en-US")).toBe(false);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as pagesMessages, with base fallback", () => {
		for (const locale of PAGES_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(pagesMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(pagesMessages("en"));
		expect(i18nMessagesFor("")).toBe(pagesMessages("en"));
	});
});
