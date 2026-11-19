import { describe, expect, it } from "vitest";

import { i18nMessagesFor, isRichTextLocale, RICH_TEXT_LOCALES, richTextMessages } from "./i18n.ts";

describe("rich-text i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = richTextMessages("en");
		for (const locale of RICH_TEXT_LOCALES) {
			const catalog = richTextMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(richTextMessages("de")).toBe(richTextMessages("en"));
		expect(richTextMessages(undefined)).toBe(richTextMessages("en"));
		expect(richTextMessages("")).toBe(richTextMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(richTextMessages("en").deleteBody("Doc")).toContain("Doc");
		expect(richTextMessages("pt-BR").deleteBody("Doc")).toContain("Doc");
		expect(richTextMessages("es").deleteBody("Doc")).toContain("Doc");
	});

	it("isRichTextLocale matches declared locales only", () => {
		expect(isRichTextLocale("en")).toBe(true);
		expect(isRichTextLocale("pt-BR")).toBe(true);
		expect(isRichTextLocale("es")).toBe(true);
		expect(isRichTextLocale("en-US")).toBe(false);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as richTextMessages, with base fallback", () => {
		for (const locale of RICH_TEXT_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(richTextMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(richTextMessages("en"));
		expect(i18nMessagesFor("")).toBe(richTextMessages("en"));
	});
});
