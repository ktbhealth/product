import { describe, expect, it } from "vitest";

import {
	ERROR_PAGE_LOCALES,
	I18N_NAMESPACE,
	i18nMessagesFor,
	errorPageMessages,
	type ErrorPageMessages,
} from "./i18n.ts";

describe("error-page i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = errorPageMessages("en");
		for (const locale of ERROR_PAGE_LOCALES) {
			const catalog: ErrorPageMessages = errorPageMessages(locale);
			for (const key of Object.keys(en) as (keyof ErrorPageMessages)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
				expect(catalog[key]).not.toBe("");
			}
		}
	});

	it("falls back to English for unknown locales", () => {
		expect(errorPageMessages("de")).toBe(errorPageMessages("en"));
		expect(errorPageMessages("")).toBe(errorPageMessages("en"));
	});

	it("exposes the DB namespace and locale accessor", () => {
		expect(I18N_NAMESPACE).toBe("error-page");
		for (const locale of ERROR_PAGE_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(errorPageMessages(locale));
		}
		expect(i18nMessagesFor("de")).toBe(errorPageMessages("en"));
	});
});
