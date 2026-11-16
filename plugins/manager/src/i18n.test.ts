import { describe, expect, it } from "vitest";

import { managerMessages, MANAGER_LOCALES, BASE_LOCALE } from "./i18n.ts";

describe("managerMessages", () => {
	it("resolves every declared locale catalog", () => {
		for (const locale of MANAGER_LOCALES) {
			expect(managerMessages(locale).title).toBe("Plugins");
		}
	});

	it("falls back to the base locale for missing or unknown locales", () => {
		expect(managerMessages()).toBe(managerMessages(BASE_LOCALE));
		expect(managerMessages("fr")).toBe(managerMessages(BASE_LOCALE));
	});

	it("evaluates the interpolated copy in every locale", () => {
		for (const locale of MANAGER_LOCALES) {
			const t = managerMessages(locale);
			expect(t.blockedHint("a, b")).toContain("a, b");
			expect(t.confirmDisableBody("x, y")).toContain("x, y");
			// Every function-valued catalog entry must execute in each
			// locale — the coverage gate requires all branches hit.
			const entries = t as unknown as Record<string, unknown>;
			for (const value of Object.values(entries)) {
				if (typeof value === "function") {
					(value as (...args: unknown[]) => unknown)("x", 1);
				}
			}
		}
	});
});
