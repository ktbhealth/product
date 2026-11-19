// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyColorScheme, COLOR_SCHEMES, readColorScheme } from "./scheme.ts";
import { THEME_SCHEME_COOKIE } from "./types.ts";

const clearSchemeCookie = () => {
	document.cookie = `${THEME_SCHEME_COOKIE}=; path=/; max-age=0`;
};

const stubMatchMedia = (matches: boolean) => {
	// jsdom does not implement window.matchMedia.
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockImplementation((query: string) => ({
			matches,
			media: query,
		})),
	);
};

afterEach(() => {
	vi.unstubAllGlobals();
	document.documentElement.classList.remove("dark");
	clearSchemeCookie();
});

describe("readColorScheme", () => {
	it("returns system when no document exists (SSR)", () => {
		vi.stubGlobal("document", undefined);
		expect(readColorScheme()).toBe("system");
	});

	it("returns system when the cookie is absent", () => {
		expect(readColorScheme()).toBe("system");
	});

	it("reads each persisted scheme value", () => {
		for (const scheme of COLOR_SCHEMES) {
			clearSchemeCookie();
			document.cookie = `${THEME_SCHEME_COOKIE}=${scheme}; path=/`;
			expect(readColorScheme()).toBe(scheme);
		}
	});

	it("ignores unrelated and malformed cookies and invalid values", () => {
		document.cookie = `other=dark; path=/`;
		document.cookie = "flagonly";
		expect(readColorScheme()).toBe("system");

		document.cookie = `${THEME_SCHEME_COOKIE}=bogus; path=/`;
		expect(readColorScheme()).toBe("system");
	});
});

describe("applyColorScheme", () => {
	it("persists the cookie and toggles .dark immediately", () => {
		stubMatchMedia(false);
		applyColorScheme("dark");
		expect(document.cookie).toContain(`${THEME_SCHEME_COOKIE}=dark`);
		expect(document.documentElement.classList.contains("dark")).toBe(true);

		applyColorScheme("light");
		expect(document.cookie).toContain(`${THEME_SCHEME_COOKIE}=light`);
		expect(document.documentElement.classList.contains("dark")).toBe(false);
	});

	it("follows the OS preference for the system scheme", () => {
		stubMatchMedia(true);
		applyColorScheme("system");
		expect(window.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
		expect(document.documentElement.classList.contains("dark")).toBe(true);

		stubMatchMedia(false);
		applyColorScheme("system");
		expect(document.documentElement.classList.contains("dark")).toBe(false);
	});
});
