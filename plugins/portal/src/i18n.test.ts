import { describe, expect, it } from "vitest";

import {
	BASE_LOCALE,
	PORTAL_LOCALES,
	isPortalLocale,
	portalMessages,
	i18nMessagesFor,
} from "./i18n.ts";

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

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of PORTAL_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(portalMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(portalMessages("en"));
		expect(i18nMessagesFor("")).toBe(portalMessages("en"));
	});
});
