import { describe, expect, it } from "vitest";

import { EVAL_CRED_LOCALES, credMessages } from "./i18n.ts";

describe("credMessages", () => {
	it("returns a catalog for every locale", () => {
		for (const locale of EVAL_CRED_LOCALES) {
			const m = credMessages(locale);
			expect(m.title.length).toBeGreaterThan(0);
			expect(m.newCred.length).toBeGreaterThan(0);
			expect(m.actionFailed.length).toBeGreaterThan(0);
		}
	});

	it("matches pt and es by prefix, falls back to English", () => {
		expect(credMessages("pt").title).toBe("Credenciais");
		expect(credMessages("es-MX").desc).toContain("Secretos");
		expect(credMessages("fr")).toBe(credMessages("en"));
	});
});
