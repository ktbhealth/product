import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	CLINICIAN_LOCALES,
	clinicianMessages,
	I18N_NAMESPACE,
	i18nMessagesFor,
	isClinicianLocale,
} from "./i18n.ts";

/** Every string leaf of a catalog (functions exercised separately). */
const leaves = (node: unknown): string[] =>
	typeof node === "string"
		? [node]
		: node && typeof node === "object"
			? Object.values(node).flatMap(leaves)
			: [];

describe("clinician catalogs", () => {
	it("resolves known locales and falls back to the base locale", () => {
		expect(isClinicianLocale("pt-BR")).toBe(true);
		expect(isClinicianLocale("es")).toBe(true);
		expect(isClinicianLocale("fr")).toBe(false);
		expect(clinicianMessages("fr")).toBe(clinicianMessages(BASE_LOCALE));
		expect(clinicianMessages("pt-BR").home.title).toBe("Área do clínico");
		expect(clinicianMessages("es").home.title).toBe("Espacio del clínico");
	});

	it("has no blank copy and identical key sets in every locale", () => {
		const baseKeys = Object.keys(clinicianMessages(BASE_LOCALE).home).sort();
		for (const locale of CLINICIAN_LOCALES) {
			const catalog = clinicianMessages(locale);
			expect(leaves(catalog).every((s) => s.trim() !== "")).toBe(true);
			expect(Object.keys(catalog.home).sort()).toEqual(baseKeys);
		}
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as clinicianMessages, with base fallback", () => {
		for (const locale of CLINICIAN_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(clinicianMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(clinicianMessages(BASE_LOCALE));
		expect(I18N_NAMESPACE).toBe("clinician");
	});
});
