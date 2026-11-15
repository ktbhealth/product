import { describe, expect, it } from "vitest";

import { BASE_LOCALE, PORTAL_LOCALES, isPortalLocale, portalMessages } from "./i18n.ts";

describe("portalMessages", () => {
	it("resolves every declared locale", () => {
		for (const locale of PORTAL_LOCALES) {
			const t = portalMessages(locale);
			expect(t.signOut.length).toBeGreaterThan(0);
			expect(t.switcherLabel.length).toBeGreaterThan(0);
		}
	});

	it("falls back to the base locale for unknown tags", () => {
		expect(portalMessages("fr")).toEqual(portalMessages(BASE_LOCALE));
		expect(isPortalLocale("fr")).toBe(false);
		expect(isPortalLocale("pt-BR")).toBe(true);
	});
});
