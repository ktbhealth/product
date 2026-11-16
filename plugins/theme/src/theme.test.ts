import { describe, expect, it } from "vitest";

import { themeCandidates } from "./theme.ts";
import { THEME_PREVIEW_COOKIE, THEME_PREVIEW_MAX_AGE } from "./types.ts";
import { themeMessages, isThemeLocale, THEME_LOCALES } from "./i18n.ts";

describe("themeCandidates — the portal-instance → tenant → platform chain", () => {
	it("portal-instance request tries instance, tenant, then platform", () => {
		expect(themeCandidates({ scope: "portal-instance", id: "clinic" }, 7)).toEqual([
			{ scope: "portal-instance", scopeId: "clinic" },
			{ scope: "tenant", scopeId: "7" },
			{ scope: "platform", scopeId: "" },
		]);
	});

	it("portal-instance without a bound tenant skips the tenant hop", () => {
		expect(themeCandidates({ scope: "portal-instance", id: "clinic" }, null)).toEqual([
			{ scope: "portal-instance", scopeId: "clinic" },
			{ scope: "platform", scopeId: "" },
		]);
	});

	it("session request is tenant → platform", () => {
		expect(themeCandidates({ scope: "session" }, 3)).toEqual([
			{ scope: "tenant", scopeId: "3" },
			{ scope: "platform", scopeId: "" },
		]);
	});

	it("tenant request is tenant → platform", () => {
		expect(themeCandidates({ scope: "tenant" }, 3)).toEqual([
			{ scope: "tenant", scopeId: "3" },
			{ scope: "platform", scopeId: "" },
		]);
	});

	it("platform request is platform only", () => {
		expect(themeCandidates({ scope: "platform" }, 3)).toEqual([{ scope: "platform", scopeId: "" }]);
	});
});

describe("preview cookie contract", () => {
	it("uses the documented cookie name and a short lifetime", () => {
		expect(THEME_PREVIEW_COOKIE).toBe("ktb-theme-preview");
		expect(THEME_PREVIEW_MAX_AGE).toBeLessThanOrEqual(60 * 60 * 24);
		expect(THEME_PREVIEW_MAX_AGE).toBeGreaterThan(0);
	});
});

describe("i18n", () => {
	it("covers every declared locale with the full key set", () => {
		for (const locale of THEME_LOCALES) {
			const messages = themeMessages(locale);
			expect(messages.pageTitle.length).toBeGreaterThan(0);
			expect(messages.bannerExit.length).toBeGreaterThan(0);
			expect(messages.headerManage.length).toBeGreaterThan(0);
		}
	});

	it("falls back to base locale for unknown tags", () => {
		expect(isThemeLocale("en")).toBe(true);
		expect(isThemeLocale("fr")).toBe(false);
		expect(themeMessages("fr")).toEqual(themeMessages("en"));
	});
});
