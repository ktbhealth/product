import { describe, expect, it } from "vitest";

import { i18nMessagesFor, isLayoutsLocale, LAYOUTS_LOCALES, layoutsMessages } from "./i18n.ts";

describe("layouts i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = layoutsMessages("en");
		for (const locale of LAYOUTS_LOCALES) {
			const catalog = layoutsMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(layoutsMessages("de")).toBe(layoutsMessages("en"));
		expect(layoutsMessages(undefined)).toBe(layoutsMessages("en"));
		expect(layoutsMessages("")).toBe(layoutsMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(layoutsMessages("en").deleteBody("q")).toContain("q");
		expect(layoutsMessages("pt-BR").deleteBody("q")).toContain("q");
		expect(layoutsMessages("es").deleteBody("q")).toContain("q");
	});

	it("isLayoutsLocale matches declared locales only", () => {
		expect(isLayoutsLocale("en")).toBe(true);
		expect(isLayoutsLocale("pt-BR")).toBe(true);
		expect(isLayoutsLocale("es")).toBe(true);
		expect(isLayoutsLocale("en-US")).toBe(false);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as layoutsMessages, with base fallback", () => {
		for (const locale of LAYOUTS_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(layoutsMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(layoutsMessages("en"));
		expect(i18nMessagesFor("")).toBe(layoutsMessages("en"));
	});
});
