import { afterEach, describe, expect, it, vi } from "vitest";

import { PATIENT_LOCALES } from "@ktb/patients/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import {
	appMessage,
	changeLocale,
	i18nSliceFromHeadMatches,
	localeFromCookieHeader,
	localeFromSearch,
	localeName,
	pluginFooterNote,
	pluginNavLabel,
	pluginPanelGroup,
	pluginPanelLabel,
	requestLocale,
} from "./i18n.ts";

/** Minimal route slice — `app.*` templates resolved server-side. */
const slice = (catalog: Record<string, string>): PageI18nSlice => ({
	locale: "en",
	catalog,
});

const FULL = slice({
	"app.locale_en": "English",
	"app.locale_pt_BR": "Português (Brasil)",
	"app.locale_es": "Español",
	"app.nav_consultations": "Consultations",
	"app.nav_patients": "Patients",
	"app.panel_nav_dashboard": "Dashboard",
	"app.panel_nav_users": "Users",
	"app.panel_nav_groups": "Groups",
	"app.panel_nav_ops": "Ops",
	"app.panel_nav_plugins": "Plugins",
	"app.panel_group_access": "Access",
	"app.panel_group_domains": "Domains",
	"app.panel_group_system": "System",
	"app.panel_group_overview": "Overview",
	"app.panel_group_clinical_data": "Clinical data",
	"app.panel_group_ai_platform": "AI platform",
	"app.panel_group_evaluation": "Evaluation",
	"app.panel_group_experience": "Experience",
	"app.panel_group_infrastructure": "Infrastructure",
	"app.footer_disclaimer": "Medical disclaimer",
});

describe("localeFromCookieHeader", () => {
	it("returns undefined for a missing header", () => {
		expect(localeFromCookieHeader(null)).toBeUndefined();
	});

	it("returns undefined when the cookie is absent", () => {
		expect(localeFromCookieHeader("session=abc; theme=dark")).toBeUndefined();
	});

	it("extracts the locale", () => {
		expect(localeFromCookieHeader("ktb-locale=pt-BR")).toBe("pt-BR");
	});

	it("extracts the locale when it is not the first cookie", () => {
		expect(localeFromCookieHeader("a=1; ktb-locale=en; b=2")).toBe("en");
	});

	it("passes through unknown values — enabled-locale validation happens downstream", () => {
		expect(localeFromCookieHeader("ktb-locale=fr")).toBe("fr");
	});
});

describe("requestLocale", () => {
	it("prefers the locale cookie", () => {
		const req = new Request("http://localhost/", {
			headers: { cookie: "ktb-locale=pt-BR" },
		});
		expect(requestLocale(req)).toBe("pt-BR");
	});

	it("falls back to the base locale without a cookie", () => {
		expect(requestLocale(new Request("http://localhost/"))).toBe("en");
	});

	it("prefers ?locale= over the cookie (QA pseudo-locale hook)", () => {
		const req = new Request("http://localhost/?locale=qps", {
			headers: { cookie: "ktb-locale=pt-BR" },
		});
		expect(requestLocale(req)).toBe("qps");
	});

	it("ignores an empty ?locale= param", () => {
		expect(requestLocale(new Request("http://localhost/?locale="))).toBe("en");
	});
});

describe("localeFromSearch", () => {
	it("extracts ?locale= from a raw query string", () => {
		expect(localeFromSearch("?locale=qps")).toBe("qps");
		expect(localeFromSearch("locale=pt-BR&foo=1")).toBe("pt-BR");
	});

	it("returns undefined when absent or empty", () => {
		expect(localeFromSearch("")).toBeUndefined();
		expect(localeFromSearch("?foo=1")).toBeUndefined();
		expect(localeFromSearch("?locale=")).toBeUndefined();
	});
});

describe("appMessage", () => {
	it("renders catalog copy for known keys", () => {
		expect(appMessage(FULL, "nav_consultations", "fallback")).toBe("Consultations");
	});

	it("resolves the English baseline when the slice is absent", () => {
		expect(appMessage(undefined, "nav_consultations", "fallback")).toBe("Consultations");
	});

	it("falls back when the key is missing", () => {
		expect(appMessage(FULL, "missing_key", "fallback")).toBe("fallback");
	});
});

describe("localeName", () => {
	it("returns the endonym for known locales", () => {
		expect(localeName("en", FULL)).toBe("English");
		expect(localeName("pt-BR", FULL)).toBe("Português (Brasil)");
		expect(localeName("es", FULL)).toBe("Español");
	});

	it("resolves baseline endonyms without a slice; unknown locales get the raw tag", () => {
		expect(localeName("fr", FULL)).toBe("fr");
		expect(localeName("en")).toBe("English");
	});
});

describe("changeLocale", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("writes the cookie and reloads without throwing", () => {
		expect(() => changeLocale("pt-BR")).not.toThrow();
	});

	it("persists the cookie with Secure + SameSite=Lax", () => {
		const jar: string[] = [];
		vi.stubGlobal("document", {
			set cookie(value: string) {
				jar.push(value);
			},
			get cookie() {
				return jar.at(-1) ?? "";
			},
		});
		vi.stubGlobal("window", { location: { reload: () => {} } });
		changeLocale("pt-BR");
		expect(jar).toHaveLength(1);
		expect(jar[0]).toContain("ktb-locale=pt-BR");
		expect(jar[0]).toContain("path=/");
		expect(jar[0]).toContain("samesite=lax");
		expect(jar[0]).toContain("secure");
	});

	it("writes the cookie without reloading when window is absent", () => {
		const jar: string[] = [];
		vi.stubGlobal("document", {
			set cookie(value: string) {
				jar.push(value);
			},
			get cookie() {
				return jar.at(-1) ?? "";
			},
		});
		vi.stubGlobal("window", undefined);
		changeLocale("es");
		expect(jar).toHaveLength(1);
		expect(jar[0]).toContain("ktb-locale=es");
	});
});

describe("pluginNavLabel", () => {
	it("localizes known plugin destinations", () => {
		expect(pluginNavLabel("/consultations", "Consultations", FULL)).toBe("Consultations");
		expect(pluginNavLabel("/patients", "Patients", FULL)).toBe("Patients");
	});

	it("falls back to the plugin-provided label", () => {
		expect(pluginNavLabel("/other", "Other", FULL)).toBe("Other");
		expect(pluginNavLabel("/consultations", "Consultations")).toBe("Consultations");
	});
});

describe("pluginPanelLabel", () => {
	it("localizes known sidebar destinations", () => {
		for (const to of [
			"/platform",
			"/platform/consultations",
			"/platform/patients",
			"/platform/users",
			"/platform/groups",
			"/portal/doctor/activity",
		]) {
			expect(pluginPanelLabel(to, "fallback", FULL)).not.toBe("fallback");
		}
	});

	it("localizes the clinical Account sidebar destinations", () => {
		for (const to of [
			"/portal/doctor/switch-doctor",
			"/portal/secretary/switch-doctor",
			"/portal/doctor/secretaries",
		]) {
			expect(pluginPanelLabel(to, "fallback")).not.toBe("fallback");
		}
	});

	it("falls back to the plugin-provided label for unknown paths", () => {
		expect(pluginPanelLabel("/platform/unknown", "Custom", FULL)).toBe("Custom");
	});
});

describe("pluginPanelGroup", () => {
	it("localizes known sidebar groups", () => {
		for (const group of [
			"Access",
			"Account",
			"Domains",
			"Governance",
			"System",
			"Overview",
			"Clinical data",
			"AI platform",
			"Evaluation",
			"Experience",
			"Infrastructure",
		]) {
			expect(pluginPanelGroup(group, FULL)).toBe(group);
		}
	});

	it("passes unknown groups through unchanged", () => {
		expect(pluginPanelGroup("Other", FULL)).toBe("Other");
	});
});

describe("pluginFooterNote", () => {
	it("localizes known footer note keys", () => {
		expect(pluginFooterNote("disclaimer", "fallback", FULL)).toBe("Medical disclaimer");
	});

	it("falls back to the plugin-provided text for unknown keys", () => {
		expect(pluginFooterNote("unknown", "Custom note", FULL)).toBe("Custom note");
	});
});

describe("i18nSliceFromHeadMatches", () => {
	const i18n = slice({ "app.meta_title": "Localized" });

	it("reads the root match's loaderData i18n slice", () => {
		const matches = [
			{ routeId: "__root__", loaderData: { i18n } },
			{ routeId: "/verify-email", loaderData: undefined },
		];
		expect(i18nSliceFromHeadMatches(matches)).toBe(i18n);
	});

	it("falls back to the first match when no __root__ id is present", () => {
		expect(i18nSliceFromHeadMatches([{ loaderData: { i18n } }])).toBe(i18n);
	});

	it("returns undefined without matches or without an i18n field", () => {
		expect(i18nSliceFromHeadMatches(undefined)).toBeUndefined();
		expect(i18nSliceFromHeadMatches([])).toBeUndefined();
		expect(i18nSliceFromHeadMatches([{ routeId: "__root__", loaderData: {} }])).toBeUndefined();
		expect(i18nSliceFromHeadMatches([{ routeId: "__root__" }])).toBeUndefined();
	});
});

describe("plugin catalogs", () => {
	// Plugins ship their own copy (they cannot import host catalogs);
	// adding an app locale must come with a catalog in each plugin.
	it("patients covers every app locale", () => {
		// i18n_locales seeds en/pt-BR/es (tools/import-i18n-baseline.mjs).
		expect([...PATIENT_LOCALES].sort()).toEqual(["en", "es", "pt-BR"]);
	});
});
