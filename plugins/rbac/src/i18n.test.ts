import { describe, expect, it } from "vitest";

import { BASE_LOCALE, isRbacLocale, RBAC_LOCALES, rbacMessages, i18nMessagesFor } from "./i18n.ts";

describe("rbac i18n", () => {
	it("every locale catalog implements the full message shape", () => {
		for (const locale of RBAC_LOCALES) {
			const m = rbacMessages(locale);
			expect(m.title.length).toBeGreaterThan(0);
			expect(m.effectAllow).toBeTruthy();
			expect(m.effectDeny).toBeTruthy();
			// Interpolating confirm descriptions resolve in every locale.
			expect(m.deleteRoleDescription("auditor")).toContain("auditor");
			expect(m.unassignDescription("u1", "auditor")).toContain("u1");
		}
	});

	it("falls back to the base locale for unknown tags", () => {
		expect(isRbacLocale("en")).toBe(true);
		expect(isRbacLocale("pt-BR")).toBe(true);
		expect(isRbacLocale("es")).toBe(true);
		expect(isRbacLocale("fr")).toBe(false);
		expect(rbacMessages("fr")).toBe(rbacMessages(BASE_LOCALE));
		expect(rbacMessages("pt-BR").title).not.toBe(rbacMessages("en").title);
	});
});

describe("i18nMessagesFor", () => {
	it("resolves the same catalog as the locale accessor, with base fallback", () => {
		for (const locale of RBAC_LOCALES) {
			expect(i18nMessagesFor(locale)).toBe(rbacMessages(locale));
		}
		expect(i18nMessagesFor("fr")).toBe(rbacMessages("en"));
		expect(i18nMessagesFor("")).toBe(rbacMessages("en"));
	});
});
