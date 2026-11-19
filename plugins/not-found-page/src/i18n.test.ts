import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	I18N_NAMESPACE,
	NOT_FOUND_PAGE_LOCALES,
	isNotFoundPageLocale,
	i18nMessagesFor,
	notFoundPageMessages,
} from "./i18n.ts";

/** Every string leaf of a catalog. */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("not-found-page catalogs", () => {
	it("resolves known locales and falls back to the base locale", () => {
		expect(isNotFoundPageLocale("pt-BR")).toBe(true);
		expect(isNotFoundPageLocale("es")).toBe(true);
		expect(isNotFoundPageLocale("fr")).toBe(false);
		expect(notFoundPageMessages("fr")).toBe(notFoundPageMessages(BASE_LOCALE));
		expect(notFoundPageMessages("pt-BR").title).toBe("Página não encontrada");
		expect(notFoundPageMessages("es").title).toBe("Página no encontrada");
	});

	it("covers every app locale", () => {
		expect([...NOT_FOUND_PAGE_LOCALES]).toEqual(["en", "pt-BR", "es"]);
	});

	it("has a complete, non-empty catalog per locale", () => {
		const keys = Object.keys(notFoundPageMessages(BASE_LOCALE)).sort();
		for (const locale of NOT_FOUND_PAGE_LOCALES) {
			const catalog = notFoundPageMessages(locale);
			expect(Object.keys(catalog).sort()).toEqual(keys);
			expect(leaves(catalog).every((s) => s.trim() !== "")).toBe(true);
		}
	});

	it("translates instead of copying the base catalog", () => {
		expect(notFoundPageMessages("pt-BR").title).not.toBe(notFoundPageMessages("en").title);
		expect(notFoundPageMessages("es").title).not.toBe(notFoundPageMessages("en").title);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of NOT_FOUND_PAGE_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(notFoundPageMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(notFoundPageMessages("en"));
		expect(i18nMessagesFor("")).toBe(notFoundPageMessages("en"));
	});
});

describe("I18N_NAMESPACE", () => {
	it("is the plugin id minus its last segment", () => {
		expect(I18N_NAMESPACE).toBe("not-found-page");
	});
});
