import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	I18N_ADMIN_LOCALES,
	I18N_NAMESPACE,
	i18nAdminMessages,
	i18nMessagesFor,
	isI18nAdminLocale,
} from "./i18n.ts";

/** Every string leaf of a catalog (functions exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

const functionsOf = (
	node: unknown,
	out: Array<(...args: unknown[]) => unknown> = [],
): Array<(...args: unknown[]) => unknown> => {
	if (typeof node === "function") out.push(node as (...args: unknown[]) => unknown);
	else if (node !== null && typeof node === "object")
		for (const value of Object.values(node)) functionsOf(value, out);
	return out;
};

describe("i18n admin catalogs", () => {
	it("resolves known locales and falls back to the base locale", () => {
		expect(isI18nAdminLocale("pt-BR")).toBe(true);
		expect(isI18nAdminLocale("es")).toBe(true);
		expect(isI18nAdminLocale("fr")).toBe(false);
		expect(i18nAdminMessages("fr")).toBe(i18nAdminMessages(BASE_LOCALE));
		expect(i18nAdminMessages("pt-BR").messages.title).toBe("Mensagens");
		expect(i18nAdminMessages("es").messages.title).toBe("Mensajes");
	});

	it("has no blank copy and identical key sets in every locale", () => {
		const baseKeys = Object.keys(i18nAdminMessages(BASE_LOCALE)).sort();
		for (const locale of I18N_ADMIN_LOCALES) {
			const catalog = i18nAdminMessages(locale);
			expect(leaves(catalog).every((s) => s.trim() !== "")).toBe(true);
			expect(Object.keys(catalog).sort()).toEqual(baseKeys);
		}
	});

	it("every catalog function returns copy in every locale", () => {
		for (const locale of I18N_ADMIN_LOCALES) {
			const fns = functionsOf(i18nAdminMessages(locale));
			expect(fns.length).toBeGreaterThan(0);
			for (const fn of fns) {
				for (const args of [["x"], ["x", 2, 1, "err"], ["en", "pt-BR", 3]]) {
					expect(typeof fn(...args)).toBe("string");
				}
			}
		}
	});

	it("interpolates the parametrized messages", () => {
		expect(i18nAdminMessages("en").drafts.bulkOk("Published", 2)).toBe("Published 2 drafts.");
		expect(i18nAdminMessages("en").drafts.bulkPartial("Published", 1, 1, " — nope")).toBe(
			"Published 1, failed 1 — nope.",
		);
		expect(i18nAdminMessages("pt-BR").messages.editCell("title", "en")).toContain("title");
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as i18nAdminMessages, with base fallback", () => {
		for (const locale of I18N_ADMIN_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(i18nAdminMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(i18nAdminMessages(BASE_LOCALE));
		expect(I18N_NAMESPACE).toBe("i18n.admin");
	});
});
