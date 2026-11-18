import { describe, expect, it } from "vitest";

import {
	AGENDA_LOCALES,
	agendaMessages,
	BASE_LOCALE,
	i18nMessagesFor,
	isAgendaLocale,
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

describe("agenda catalogs", () => {
	it("resolves known locales and falls back to the base locale", () => {
		expect(isAgendaLocale("pt-BR")).toBe(true);
		expect(isAgendaLocale("fr")).toBe(false);
		expect(agendaMessages("fr")).toBe(agendaMessages(BASE_LOCALE));
		expect(agendaMessages("pt-BR").status.scheduled).toBe("Agendado");
	});

	it("has no blank copy in any locale", () => {
		for (const locale of AGENDA_LOCALES) {
			expect(leaves(agendaMessages(locale)).every((s) => s.trim() !== "")).toBe(true);
		}
	});

	it("every catalog function returns copy in every locale", () => {
		for (const locale of AGENDA_LOCALES) {
			const fns = functionsOf(agendaMessages(locale));
			expect(fns.length).toBeGreaterThan(0);
			for (const fn of fns) {
				for (const args of [[1], [30], [0]]) {
					expect(typeof fn(...(args as [number]))).toBe("string");
				}
			}
		}
	});

	it("interpolates the reminder-style messages", () => {
		expect(agendaMessages("en").startingSoon(5)).toBe("Starts in 5 min");
		expect(agendaMessages("pt-BR").durationMin(30)).toBe("30 min");
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of AGENDA_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(agendaMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(agendaMessages("en"));
	});
});
