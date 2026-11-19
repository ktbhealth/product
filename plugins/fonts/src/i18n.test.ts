import { describe, expect, it } from "vitest";

import { fontMessages, isFontLocale, FONTS_LOCALES, I18N_NAMESPACE } from "./i18n.ts";

describe("fonts i18n", () => {
	it("covers every declared locale with the full key set", () => {
		for (const locale of FONTS_LOCALES) {
			const m = fontMessages(locale);
			expect(m.providersTitle.length).toBeGreaterThan(0);
			expect(m.fontsTitle.length).toBeGreaterThan(0);
			expect(m.deleteConfirm.length).toBeGreaterThan(0);
			expect(m.syncedToast.length).toBeGreaterThan(0);
		}
	});

	it("locales differ from the base catalog", () => {
		expect(fontMessages("pt-BR").providersTitle).not.toBe(fontMessages("en").providersTitle);
		expect(fontMessages("es").fontsTitle).not.toBe(fontMessages("en").fontsTitle);
	});

	it("falls back to base locale for unknown tags", () => {
		expect(isFontLocale("en")).toBe(true);
		expect(isFontLocale("fr")).toBe(false);
		expect(fontMessages("fr")).toEqual(fontMessages("en"));
	});

	it("declares the fonts namespace for baseline import", () => {
		expect(I18N_NAMESPACE).toBe("fonts");
	});
});
