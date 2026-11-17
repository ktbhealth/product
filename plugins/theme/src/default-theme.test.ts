import { describe, expect, it } from "vitest";

import { KTB_DEFAULT_THEME } from "./default-theme.ts";
import { deriveThemeTokens } from "./palette.ts";
import { themeStyleCss } from "./present.ts";

describe("KTB_DEFAULT_THEME — the built-in platform default (PL-006 phase 7)", () => {
	it("is a synthetic platform-scope ResolvedTheme carrying the KTB brand", () => {
		expect(KTB_DEFAULT_THEME.id).toBe(0);
		expect(KTB_DEFAULT_THEME.scope).toBe("platform");
		expect(KTB_DEFAULT_THEME.scopeId).toBe("");
		expect(KTB_DEFAULT_THEME.appName).toBe("KTB Health");
		expect(KTB_DEFAULT_THEME.brand?.appName).toBe("KTB Health");
	});

	it("references real brand assets for logo, wordmark and favicon", () => {
		const brand = KTB_DEFAULT_THEME.brand;
		expect(brand?.logoLight).toBeTruthy();
		expect(brand?.logoDark).toBeTruthy();
		expect(brand?.wordmark).toBeTruthy();
		expect(brand?.favicon).toBeTruthy();
	});

	it("derives tokens from the stock ui seeds — never stored state", () => {
		expect(KTB_DEFAULT_THEME.tokens).toEqual(deriveThemeTokens(KTB_DEFAULT_THEME.seeds));
		expect(KTB_DEFAULT_THEME.styleCss).toBe(
			themeStyleCss({
				seeds: KTB_DEFAULT_THEME.seeds,
				fonts: KTB_DEFAULT_THEME.fonts,
			}),
		);
		expect(KTB_DEFAULT_THEME.styleCss).toContain(":root{");
		expect(KTB_DEFAULT_THEME.styleCss).toContain(".dark{");
		// Stock ui primary hues survive derivation.
		expect(KTB_DEFAULT_THEME.tokens.light["--primary"]).toContain("259.02");
		expect(KTB_DEFAULT_THEME.tokens.dark["--primary"]).toContain("259.76");
	});

	it("keeps the Geist font stack with self-host delivery and no assets yet", () => {
		expect(KTB_DEFAULT_THEME.fonts?.delivery).toBe("self-host");
		expect(KTB_DEFAULT_THEME.fonts?.families?.sans).toBe("Geist");
		expect(KTB_DEFAULT_THEME.fonts?.families?.mono).toBe("Geist Mono");
		// No font files until the Phase 4 asset pipeline fills assets.
		expect(KTB_DEFAULT_THEME.fontLinks).toEqual([]);
		expect(KTB_DEFAULT_THEME.fontFaceCss).toBe("");
		expect(KTB_DEFAULT_THEME.styleCss).toContain('"Geist"');
	});
});
