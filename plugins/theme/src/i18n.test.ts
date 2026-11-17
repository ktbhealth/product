import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	I18N_NAMESPACE,
	THEME_LOCALES,
	i18nMessagesFor,
	isThemeLocale,
	themeMessages,
	type ThemeMessages,
} from "./i18n.ts";

/** Every string leaf of a catalog. */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("theme catalogs", () => {
	it("resolves known locales and falls back to the base locale", () => {
		expect(isThemeLocale("pt-BR")).toBe(true);
		expect(isThemeLocale("es")).toBe(true);
		expect(isThemeLocale("fr")).toBe(false);
		expect(themeMessages("fr")).toBe(themeMessages(BASE_LOCALE));
		expect(themeMessages("pt-BR").publish).toBe("Publicar tema");
	});

	it("i18nMessagesFor mirrors themeMessages for the baseline importer", () => {
		expect(i18nMessagesFor("es")).toBe(themeMessages("es"));
		expect(i18nMessagesFor("zz")).toBe(themeMessages(BASE_LOCALE));
		expect(I18N_NAMESPACE).toBe("theme");
	});

	it("has no blank copy and identical key sets in every locale", () => {
		const baseKeys = Object.keys(themeMessages(BASE_LOCALE) as ThemeMessages).sort();
		for (const locale of THEME_LOCALES) {
			const catalog = themeMessages(locale);
			expect(leaves(catalog).every((s) => s.trim() !== "")).toBe(true);
			expect(Object.keys(catalog as ThemeMessages).sort()).toEqual(baseKeys);
		}
	});
});
