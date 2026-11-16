import { describe, expect, it } from "vitest";

import { EVAL_LOCALES, evalLabMessages } from "./i18n.ts";

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
