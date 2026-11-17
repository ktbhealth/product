import { describe, expect, it } from "vitest";

import {
	I18N_NAMESPACE,
	i18nMessagesFor,
	isWizardsLocale,
	WIZARDS_LOCALES,
	wizardsMessages,
} from "./i18n.ts";

describe("wizards i18n", () => {
	it("serves a complete catalog for every declared locale", () => {
		const en = wizardsMessages("en");
		for (const locale of WIZARDS_LOCALES) {
			const catalog = wizardsMessages(locale);
			for (const key of Object.keys(en) as (keyof typeof en)[]) {
				expect(catalog[key], `${locale}.${key}`).toBeDefined();
			}
		}
	});

	it("falls back to English for unknown or missing locales", () => {
		expect(wizardsMessages("de")).toBe(wizardsMessages("en"));
		expect(wizardsMessages(undefined)).toBe(wizardsMessages("en"));
		expect(wizardsMessages("")).toBe(wizardsMessages("en"));
	});

	it("resolves function-valued messages per locale", () => {
		expect(wizardsMessages("en").stepProgress(1, 3)).toBe("Step 1 of 3");
		expect(wizardsMessages("pt-BR").stepProgress(2, 4)).toContain("2");
		expect(wizardsMessages("es").stepProgress(2, 4)).toContain("2");
	});

	it("isWizardsLocale matches declared locales only", () => {
		expect(isWizardsLocale("en")).toBe(true);
		expect(isWizardsLocale("pt-BR")).toBe(true);
		expect(isWizardsLocale("es")).toBe(true);
		expect(isWizardsLocale("en-US")).toBe(false);
	});

	it("exposes the baseline-importer contract", () => {
		expect(I18N_NAMESPACE).toBe("wizards");
		expect(i18nMessagesFor("pt-BR")).toBe(wizardsMessages("pt-BR"));
	});
});
