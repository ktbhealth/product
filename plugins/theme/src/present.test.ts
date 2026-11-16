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

	it("fontFaceCss emits per-weight faces + metric-matched fallback for structured assets", () => {
		const fonts = {
			delivery: "self-host" as const,
			assets: {
				Inter: {
					faces: [
						{ url: "/api/theme/assets?key=a.woff2", weight: 400, format: "woff2" },
						{ url: "/api/theme/assets?key=b.woff", weight: 700 },
						{ url: "" }, // skipped
					],
					fallback: {
						name: "Inter fallback",
						local: "Arial",
						metrics: {
							sizeAdjust: 112.16,
							ascentOverride: 75.4,
							descentOverride: 18.9,
							lineGapOverride: 0,
						},
					},
				},
				// Bare-string legacy asset still works; format inferred from ext.
				Mono: "https://cdn.example.com/mono.ttf",
				// Empty/malformed entries emit nothing.
				Empty: { faces: [] },
				Weird: 42 as never,
			},
		};
		const css = fontFaceCss(fonts);
		const rules = css.split("\n");
		expect(rules).toHaveLength(4);
		expect(rules[0]).toContain('font-family:"Inter"');
		expect(rules[0]).toContain('format("woff2")');
		expect(rules[0]).toContain("font-weight:400");
		expect(rules[1]).toContain('format("woff")'); // explicit format wins over ext
		expect(rules[1]).toContain("font-weight:700");
		expect(rules[2]).toContain('font-family:"Inter fallback"');
		expect(rules[2]).toContain('local("Arial")');
		expect(rules[2]).toContain('local("Arial Regular")');
		expect(rules[2]).toContain("size-adjust:112.16%");
		expect(rules[2]).toContain("ascent-override:75.4%");
		expect(rules[2]).toContain("descent-override:18.9%");
		expect(rules[2]).toContain("line-gap-override:0%");
		expect(rules[3]).toContain('font-family:"Mono"');
		expect(rules[3]).toContain('format("truetype")'); // inferred from .ttf
	});

	it("fontFaceCss skips fallbacks without a usable local() name", () => {
		const css = fontFaceCss({
			delivery: "self-host",
			assets: {
				Inter: {
					faces: [{ url: "/a.woff2", weight: 400.5 }], // non-integer weight omitted
					fallback: {
						name: "F",
						local: "  ",
						metrics: { sizeAdjust: 1, ascentOverride: 1, descentOverride: 1, lineGapOverride: 0 },
					},
				},
				Other: { faces: [{ url: "/b.woff2" }], fallback: null },
			},
		});
		expect(css).not.toContain("size-adjust");
		expect(css).not.toContain("font-weight");
		expect(css.match(/@font-face/g)).toHaveLength(2);
	});

	it("fontCssVars inserts the metric-matched fallback into the stack", () => {
		const vars = fontCssVars({
			delivery: "self-host",
			families: { sans: "Inter" },
			assets: {
				Inter: {
					faces: [],
					fallback: {
						name: "Inter fallback",
						local: "Arial",
						metrics: {
							sizeAdjust: 100,
							ascentOverride: 80,
							descentOverride: 20,
							lineGapOverride: 0,
						},
					},
				},
			},
		});
		expect(vars["--font-sans"]).toBe(
			'"Inter", "Inter fallback", ui-sans-serif, system-ui, -apple-system, sans-serif',
		);
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
