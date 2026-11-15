import { describe, expect, it } from "vitest";

import {
	fontFaceCss,
	fontCssVars,
	googleFontLinks,
	presentTheme,
	themeStyleCss,
} from "./present.ts";
import type { ThemeDefinitionRow } from "./present.ts";
import { themeHead, themeAssets, themeTitle } from "./head.ts";

const row = (overrides: Partial<ThemeDefinitionRow> = {}): ThemeDefinitionRow => ({
	id: 1,
	scope: "platform",
	scopeId: "",
	appName: null,
	seeds: "{}",
	tokens: "{}",
	fonts: null,
	brand: null,
	enabled: true,
	version: 1,
	...overrides,
});

describe("presentTheme", () => {
	it("presents a minimal row with derived tokens and style css", () => {
		const theme = presentTheme(row());
		expect(theme.scope).toBe("platform");
		expect(theme.tokens.light["--primary"]).toMatch(/^oklch\(/);
		expect(theme.styleCss).toContain(":root{");
		expect(theme.styleCss).toContain(".dark{");
		expect(theme.fontLinks).toEqual([]);
		expect(theme.fontFaceCss).toBe("");
		expect(theme.brand).toBeNull();
	});

	it("marks preview rows without persisting anything", () => {
		const theme = presentTheme(row(), { preview: true });
		expect(theme.preview).toBe(true);
		expect(presentTheme(row()).preview).toBeUndefined();
	});

	it("tolerates malformed JSON columns", () => {
		const theme = presentTheme(row({ seeds: "{oops", fonts: "nope", brand: "[]" }));
		expect(theme.seeds).toEqual({});
		expect(theme.fonts).toBeNull();
		expect(theme.brand).toBeNull();
		expect(theme.styleCss).toContain(":root{");
	});

	it("appName falls back to brand.appName", () => {
		const theme = presentTheme(row({ brand: JSON.stringify({ appName: "Acme Health" }) }));
		expect(theme.appName).toBe("Acme Health");
	});
});

describe("fonts", () => {
	it("googleFontLinks emits css2 hrefs only for google-fonts delivery", () => {
		const fonts = {
			delivery: "google-fonts" as const,
			families: { sans: "Inter", heading: "Inter", mono: "JetBrains Mono" },
			weights: [400, 700],
		};
		const links = googleFontLinks(fonts);
		expect(links).toHaveLength(2);
		expect(links[0]).toContain("fonts.googleapis.com/css2");
		expect(links[0]).toContain("Inter");
		expect(links[0]).toContain("wght@400;700");
		expect(googleFontLinks({ ...fonts, delivery: "self-host" })).toEqual([]);
		expect(googleFontLinks(null)).toEqual([]);
	});

	it("fontCssVars sets semantic + geist alias vars", () => {
		const vars = fontCssVars({
			delivery: "self-host",
			families: { sans: "Inter", mono: "JetBrains Mono" },
		});
		expect(vars["--font-sans"]).toContain('"Inter"');
		expect(vars["--font-heading"]).toContain('"Inter"'); // falls back to sans
		expect(vars["--font-mono"]).toContain('"JetBrains Mono"');
		expect(vars["--font-geist"]).toBe(vars["--font-sans"]);
	});

	it("fontCssVars is empty without config", () => {
		expect(fontCssVars(null)).toEqual({});
	});

	it("fontFaceCss emits @font-face only for self-host assets", () => {
		const fonts = {
			delivery: "self-host" as const,
			assets: { Inter: "https://cdn.example.com/inter.woff2" },
		};
		const css = fontFaceCss(fonts);
		expect(css).toContain("@font-face");
		expect(css).toContain("Inter");
		expect(fontFaceCss({ ...fonts, delivery: "google-fonts" })).toBe("");
		expect(fontFaceCss({ delivery: "self-host" })).toBe("");
	});

	it("themeStyleCss folds font vars into :root", () => {
		const css = themeStyleCss({
			seeds: { primary: "#2563eb" },
			fonts: { delivery: "self-host", families: { sans: "Inter" } },
		});
		expect(css).toContain("--font-sans");
		expect(css.split("\n")[1]).not.toContain("--font-sans"); // .dark inherits
	});
});

describe("themeHead / themeAssets / themeTitle", () => {
	const themed = presentTheme(
		row({
			appName: "Acme",
			brand: JSON.stringify({
				favicon: "/favicon.ico",
				ogImage: "https://cdn.example.com/og.png",
			}),
			fonts: JSON.stringify({
				delivery: "google-fonts",
				families: { sans: "Inter" },
			}),
		}),
	);

	it("emits favicon, font and og tags plus one style block", () => {
		const head = themeHead(themed);
		expect(head.links.some((l) => l.rel === "icon")).toBe(true);
		expect(head.links.some((l) => l.rel === "stylesheet")).toBe(true);
		expect(head.meta.some((m) => m.property === "og:image")).toBe(true);
		expect(head.styles).toHaveLength(1);
		expect(head.styles[0]!.children).toContain(":root{");
		expect(head.styles[0]!.children).toContain(".dark{");
	});

	it("themeAssets tolerates null theme", () => {
		expect(themeAssets(null)).toEqual({ links: [], styles: [] });
	});

	it("themeTitle prefers brand appName then row appName", () => {
		expect(themeTitle(themed)).toBe("Acme");
		expect(themeTitle(null)).toBeNull();
	});
});
