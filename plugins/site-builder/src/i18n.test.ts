import { describe, expect, it } from "vitest";

import {
	i18nMessagesFor,
	isSiteBuilderLocale,
	SITE_BUILDER_LOCALES,
	siteBuilderMessages,
} from "./i18n.ts";

describe("site-builder i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = siteBuilderMessages("en");
		for (const locale of SITE_BUILDER_LOCALES) {
			const catalog = siteBuilderMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(siteBuilderMessages("de")).toBe(siteBuilderMessages("en"));
		expect(siteBuilderMessages(undefined)).toBe(siteBuilderMessages("en"));
		expect(siteBuilderMessages("")).toBe(siteBuilderMessages("en"));
	});

	it("isSiteBuilderLocale matches declared locales only", () => {
		expect(isSiteBuilderLocale("en")).toBe(true);
		expect(isSiteBuilderLocale("pt-BR")).toBe(true);
		expect(isSiteBuilderLocale("es")).toBe(true);
		expect(isSiteBuilderLocale("en-US")).toBe(false);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as siteBuilderMessages, with base fallback", () => {
		for (const locale of SITE_BUILDER_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(siteBuilderMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(siteBuilderMessages("en"));
		expect(i18nMessagesFor("")).toBe(siteBuilderMessages("en"));
	});
});
