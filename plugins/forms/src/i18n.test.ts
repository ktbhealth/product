import { describe, expect, it } from "vitest";

import {
	formsMessages,
	i18nMessagesFor,
	isFormsLocale,
	FORMS_LOCALES,
	I18N_NAMESPACE,
} from "./i18n.ts";

describe("forms i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = formsMessages("en");
		for (const locale of FORMS_LOCALES) {
			const catalog = formsMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(formsMessages("de")).toBe(formsMessages("en"));
		expect(formsMessages(undefined)).toBe(formsMessages("en"));
		expect(formsMessages("")).toBe(formsMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(formsMessages("en").invalidSummary(1)).toContain("1");
		expect(formsMessages("en").invalidSummary(3)).toContain("3");
		expect(formsMessages("pt-BR").invalidSummary(2)).toContain("2");
		expect(formsMessages("es").invalidSummary(2)).toContain("2");
	});

	it("isFormsLocale matches declared locales only", () => {
		expect(isFormsLocale("en")).toBe(true);
		expect(isFormsLocale("pt-BR")).toBe(true);
		expect(isFormsLocale("es")).toBe(true);
		expect(isFormsLocale("en-US")).toBe(false);
	});

	it("exposes the baseline-importer contract", () => {
		expect(I18N_NAMESPACE).toBe("forms");
		expect(i18nMessagesFor("pt-BR")).toBe(formsMessages("pt-BR"));
	});
});
