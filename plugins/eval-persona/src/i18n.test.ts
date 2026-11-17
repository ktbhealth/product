import { describe, expect, it } from "vitest";

import { EVAL_LOCALES, evalLabMessages, i18nMessagesFor } from "./i18n.ts";

describe("evalLabMessages", () => {
	it("returns a catalog for every locale", () => {
		for (const locale of EVAL_LOCALES) {
			const m = evalLabMessages(locale);
			expect(m.personasTitle.length).toBeGreaterThan(0);
			expect(m.instancesTitle.length).toBeGreaterThan(0);
			expect(m.endpointTemplate.length).toBeGreaterThan(0);
		}
	});

	it("falls back to English for unknown locales", () => {
		expect(evalLabMessages("fr")).toBe(evalLabMessages("en"));
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as evalLabMessages, with English fallback", () => {
		for (const locale of EVAL_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(evalLabMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(evalLabMessages("en"));
	});
});
