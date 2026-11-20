import { describe, expect, it } from "vitest";

import {
	i18nMessagesFor,
	isTemplatesLocale,
	TEMPLATES_LOCALES,
	templatesMessages,
} from "./i18n.ts";

describe("templates i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = templatesMessages("en");
		for (const locale of TEMPLATES_LOCALES) {
			const catalog = templatesMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(templatesMessages("de")).toBe(templatesMessages("en"));
		expect(templatesMessages(undefined)).toBe(templatesMessages("en"));
		expect(templatesMessages("")).toBe(templatesMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(templatesMessages("en").deleteBody("q")).toContain("q");
		expect(templatesMessages("pt-BR").deleteBody("q")).toContain("q");
		expect(templatesMessages("es").deleteBody("q")).toContain("q");
		expect(templatesMessages("en").saveAsBody("q")).toContain("q");
	});

	it("isTemplatesLocale matches declared locales only", () => {
		expect(isTemplatesLocale("en")).toBe(true);
		expect(isTemplatesLocale("pt-BR")).toBe(true);
		expect(isTemplatesLocale("es")).toBe(true);
		expect(isTemplatesLocale("en-US")).toBe(false);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as templatesMessages, with base fallback", () => {
		for (const locale of TEMPLATES_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(templatesMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(templatesMessages("en"));
		expect(i18nMessagesFor("")).toBe(templatesMessages("en"));
	});
});
