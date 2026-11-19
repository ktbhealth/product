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

	it("appName stays null when neither column nor brand carries one", () => {
		const theme = presentTheme(row({ brand: JSON.stringify({ logoLight: "/l.svg" }) }));
		expect(theme.appName).toBeNull();
		expect(theme.brand?.logoLight).toBe("/l.svg");
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

	it("fontCssVars tolerates missing/blank families and non-object assets", () => {
		// No families map at all → every slot keeps its fallback stack.
		const vars = fontCssVars({ delivery: "self-host" });
		expect(vars["--font-sans"]).toContain("ui-sans-serif");
		// A quoted-empty family name strips to "" — no metric fallback.
		// String assets and blank fallback names yield no local() face.
		const edge = fontCssVars({
			delivery: "self-host",
			families: { sans: '""', heading: "Blank", mono: "Mono" },
			assets: {
				Blank: {
					faces: [],
					fallback: {
						name: "  ",
						local: "Arial",
						metrics: {
							sizeAdjust: 100,
							ascentOverride: 80,
							descentOverride: 20,
							lineGapOverride: 0,
						},
					},
				},
				Mono: {
					faces: [{ url: "/m.woff2" }],
					fallback: {
						name: "F",
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
		expect(edge["--font-sans"]).toContain("ui-sans-serif");
		expect(edge["--font-heading"]).toContain('"Blank"');
		expect(edge["--font-mono"]).toContain('"F"'); // metric fallback inserted
	});

	it("googleFontLinks tolerates missing families and filters bad weights", () => {
		expect(googleFontLinks({ delivery: "google-fonts" })).toEqual([]);
		const links = googleFontLinks({
			delivery: "google-fonts",
			families: { sans: "Inter" },
			weights: [50, 1000, 400],
		});
		expect(links[0]).toContain("wght@400");
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
						{
							url: "/api/theme/assets?key=a.woff2",
							weight: 400,
							format: "woff2",
						},
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

	it("fontFaceCss emits weight ranges and unicode-range for variable fonts", () => {
		const css = fontFaceCss({
			delivery: "self-host",
			assets: {
				Var: {
					faces: [
						{
							url: "/api/theme/assets?key=var.woff2",
							weightRange: [100, 900],
							unicodeRange: "U+0020-007E, U+00C0-00FF",
							format: "woff2",
						},
						// Malformed range falls back to discrete weight.
						{ url: "/b.woff2", weightRange: [900, 100] as never, weight: 400 },
						// weightRange wins over weight when both are sane.
						{ url: "/c.woff2", weightRange: [200, 800], weight: 400 },
					],
				},
				// unicode-range values outside the descriptor alphabet are
				// dropped (stored JSON is untrusted input).
				Evil: {
					faces: [
						{ url: "/e.woff2", unicodeRange: "U+0041;}body{display:none" },
						{ url: "/f.woff2", unicodeRange: "not-a-range" },
					],
				},
			},
		});
		const rules = css.split("\n");
		expect(rules[0]).toContain("font-weight:100 900");
		expect(rules[0]).toContain("unicode-range:U+0020-007E, U+00C0-00FF");
		expect(rules[1]).toContain("font-weight:400");
		expect(rules[1]).not.toContain("font-weight:900 100");
		expect(rules[2]).toContain("font-weight:200 800");
		expect(rules[3]).not.toContain("unicode-range");
		expect(rules[4]).not.toContain("unicode-range");
	});

	it("fontFaceCss emits font-stretch for wdth axes and nothing for other axes", () => {
		const css = fontFaceCss({
			delivery: "self-host",
			assets: {
				Var: {
					faces: [
						{
							url: "/a.woff2",
							weightRange: [100, 900],
							axes: [
								{ tag: "wdth", min: 75, default: 100, max: 125 },
								// Non-wdth axes have no @font-face descriptor —
								// stored for element-level font-variation-settings.
								{ tag: "opsz", min: 6, default: 14, max: 72 },
								{ tag: "slnt", min: -12, default: 0, max: 0 },
							],
						},
						// Pinned wdth (min === max) collapses to one value.
						{ url: "/b.woff2", axes: [{ tag: "wdth", min: 80, default: 80, max: 80 }] },
						// Malformed/inverted/out-of-domain values → no descriptor.
						{ url: "/c.woff2", axes: [{ tag: "wdth", min: 125, default: 100, max: 75 }] },
						{ url: "/d.woff2", axes: [{ tag: "wdth", min: -5, default: 100, max: 125 }] },
						{
							url: "/e.woff2",
							axes: [{ tag: "wdth", min: "wide", default: 100, max: 125 }] as never,
						},
						// Non-finite / out-of-domain / sub-rounding endpoints.
						{ url: "/h.woff2", axes: [{ tag: "wdth", min: Infinity, default: 100, max: 125 }] },
						{ url: "/i.woff2", axes: [{ tag: "wdth", min: 0.00001, default: 100, max: 125 }] },
						{ url: "/j.woff2", axes: [{ tag: "wdth", min: 20000, default: 100, max: 125 }] },
						// Case-sensitive tag + non-object entries are ignored.
						{
							url: "/f.woff2",
							axes: [
								"junk",
								null,
								{ tag: "WDTH", min: 75, default: 100, max: 125 },
								{ tag: "opsz", min: 6, default: 14, max: 72 },
							] as never,
						},
						// axes not an array → nothing.
						{ url: "/g.woff2", axes: "nope" as never },
					],
				},
			},
		});
		const rules = css.split("\n");
		expect(rules[0]).toContain("font-weight:100 900");
		expect(rules[0]).toContain("font-stretch:75% 125%");
		expect(rules[0]).not.toContain("font-variation-settings");
		expect(rules[1]).toContain("font-stretch:80%");
		expect(rules[1]).not.toContain("font-stretch:80% 80%");
		for (let i = 2; i <= 9; i++) {
			expect(rules[i]).not.toContain("font-stretch");
		}
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
						metrics: {
							sizeAdjust: 1,
							ascentOverride: 1,
							descentOverride: 1,
							lineGapOverride: 0,
						},
					},
				},
				Other: { faces: [{ url: "/b.woff2" }], fallback: null },
			},
		});
		expect(css).not.toContain("size-adjust");
		expect(css).not.toContain("font-weight");
		expect(css.match(/@font-face/g)).toHaveLength(2);
	});

	it("fontFaceCss infers format from ?key= serving URLs and skips malformed assets", () => {
		const css = fontFaceCss({
			delivery: "self-host",
			assets: {
				// Extension lives in the R2 key query param, not the path.
				Keyed: "/api/theme/assets?key=theme-assets/1/font/x.woff2",
				NoExt: "/api/theme/assets?key=theme-assets/1/font/x",
				Empty: "   ",
				Nil: null as never,
				BadFaces: { faces: "nope" as never },
				Unknown: { faces: [{ url: "/f.bin", weight: 400 }] },
				// No path extension and no ?key= param → default format.
				Bare: "/api/theme/assets?x=1",
				// ?key= present but extensionless → default format.
				KeyNoExt: "/api/theme/assets?key=abc",
			},
		});
		const rules = css.split("\n");
		expect(rules).toHaveLength(5);
		expect(rules[0]).toContain('font-family:"Keyed"');
		expect(rules[0]).toContain('format("woff2")');
		expect(rules[1]).toContain('font-family:"NoExt"');
		expect(rules[1]).toContain('format("woff2")'); // default when ext unknown
		expect(rules[2]).toContain('font-family:"Unknown"');
		expect(rules[2]).toContain('format("woff2")');
		expect(rules[3]).toContain('font-family:"Bare"');
		expect(rules[3]).toContain('format("woff2")');
		expect(rules[4]).toContain('font-family:"KeyNoExt"');
		expect(rules[4]).toContain('format("woff2")');
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
		expect(themeAssets(undefined)).toEqual({ links: [], styles: [] });
	});

	it("themeAssets projects links and styles for a real theme", () => {
		const assets = themeAssets(themed);
		expect(assets.links.length).toBeGreaterThan(0);
		expect(assets.styles).toHaveLength(1);
	});

	it("themeHead skips blank/non-string brand fields and empty css", () => {
		const bare = {
			brand: { favicon: "   ", ogImage: 42 },
			fontLinks: [],
			styleCss: "",
			fontFaceCss: "",
			fonts: null,
		} as unknown as Parameters<typeof themeHead>[0];
		const head = themeHead(bare);
		expect(head.links).toEqual([]);
		expect(head.meta).toEqual([]);
		expect(head.styles).toEqual([]);
		const nonString = {
			brand: { favicon: 7 },
			fontLinks: [],
			styleCss: "",
			fontFaceCss: "",
			fonts: null,
		} as unknown as Parameters<typeof themeHead>[0];
		expect(themeHead(nonString).links).toEqual([]);
	});

	it("themeTitle prefers brand appName then row appName", () => {
		expect(themeTitle(themed)).toBe("Acme");
		expect(themeTitle(null)).toBeNull();
	});
});

describe("presentTheme — managed font cascade", () => {
	const managedRow = (fonts: unknown) => row({ fonts: JSON.stringify(fonts) });

	it("googlefonts managed sources emit catalog-weight stylesheet links and slot names", () => {
		const theme = presentTheme(
			managedRow({
				delivery: "self-host",
				families: { sans: "Free Sans" },
				sources: { sans: { providerId: 7, family: "Inter" } },
			}),
			{
				managed: [
					{
						providerId: 7,
						family: "Inter",
						kind: "googlefonts",
						weights: [400, 700],
					},
				],
			},
		);
		expect(theme.fontLinks).toEqual([
			"https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
		]);
		// The managed family wins the slot even though delivery is self-host.
		expect(theme.styleCss).toContain('"Inter"');
		expect(theme.styleCss).not.toContain('"Free Sans"');
		// The stored config round-trips untouched.
		expect(theme.fonts?.families?.sans).toBe("Free Sans");
		expect(theme.fonts?.sources?.sans).toEqual({ providerId: 7, family: "Inter" });
	});

	it("managed googlefonts families are excluded from the free-form link pass", () => {
		const theme = presentTheme(
			managedRow({
				delivery: "google-fonts",
				families: { sans: "Inter", mono: "Roboto Mono" },
				weights: [100],
				sources: { sans: { providerId: 7, family: "Inter" } },
			}),
			{
				managed: [{ providerId: 7, family: "Inter", kind: "googlefonts", weights: [400, 700] }],
			},
		);
		// Inter emits once with catalog weights; Roboto Mono keeps the
		// theme's google-fonts delivery with theme weights. Links follow
		// slot priority — the managed sans link precedes the mono one.
		expect(theme.fontLinks).toHaveLength(2);
		expect(theme.fontLinks[0]).toContain("Inter:wght@400;700");
		expect(theme.fontLinks[1]).toContain("Roboto");
		expect(theme.fontLinks[1]).toContain("wght@100");
	});

	it("orders fontLinks by slot priority with managed sources first per slot", () => {
		const theme = presentTheme(
			managedRow({
				delivery: "google-fonts",
				families: { sans: "Free Sans", heading: "Head Font", mono: "Mono Font" },
				weights: [400],
				sources: { heading: { providerId: 7, family: "Managed Head" } },
			}),
			{
				managed: [
					{
						providerId: 7,
						family: "Managed Head",
						kind: "googlefonts",
						weights: [600],
					},
				],
			},
		);
		// Slot order beats managed/free-form grouping: sans free-form,
		// then the heading slot's managed link followed by its distinct
		// free-form family, then mono.
		expect(theme.fontLinks).toEqual([
			"https://fonts.googleapis.com/css2?family=Free+Sans:wght@400&display=swap",
			"https://fonts.googleapis.com/css2?family=Managed+Head:wght@600&display=swap",
			"https://fonts.googleapis.com/css2?family=Head+Font:wght@400&display=swap",
			"https://fonts.googleapis.com/css2?family=Mono+Font:wght@400&display=swap",
		]);
	});

	it("dedupes fontLinks by family keeping the first (highest-priority) slot", () => {
		const theme = presentTheme(
			managedRow({
				delivery: "google-fonts",
				families: { sans: "Inter", heading: "Inter", mono: "JetBrains Mono" },
			}),
		);
		expect(theme.fontLinks).toHaveLength(2);
		expect(theme.fontLinks[0]).toContain("Inter");
		expect(theme.fontLinks[1]).toContain("JetBrains");
	});

	it("keeps both links when a managed source and a free-form name differ per slot", () => {
		const theme = presentTheme(
			managedRow({
				delivery: "google-fonts",
				families: { sans: "Free Sans" },
				sources: { sans: { providerId: 7, family: "Inter" } },
			}),
			{
				managed: [{ providerId: 7, family: "Inter", kind: "googlefonts", weights: [400] }],
			},
		);
		// Managed Inter leads its slot; the distinct free-form family
		// still emits (same as the pre-merge behavior, reordered).
		expect(theme.fontLinks).toHaveLength(2);
		expect(theme.fontLinks[0]).toContain("Inter:wght@400");
		expect(theme.fontLinks[1]).toContain("Free+Sans");
	});

	it("self-host managed sources emit @font-face regardless of delivery", () => {
		const asset = {
			faces: [{ url: "/api/theme/assets?key=brand.woff2", weight: 400, format: "woff2" }],
			fallback: {
				name: "Brand Sans fallback",
				local: "Arial",
				metrics: { sizeAdjust: 100, ascentOverride: 90, descentOverride: 20, lineGapOverride: 0 },
			},
		};
		const theme = presentTheme(
			managedRow({
				delivery: "google-fonts",
				sources: { sans: { providerId: 3, family: "Brand Sans" } },
			}),
			{
				managed: [
					{
						providerId: 3,
						family: "Brand Sans",
						kind: "local",
						weights: [],
						asset,
					},
				],
			},
		);
		expect(theme.fontFaceCss).toContain('@font-face{font-family:"Brand Sans"');
		expect(theme.fontFaceCss).toContain('format("woff2")');
		expect(theme.fontFaceCss).toContain('font-family:"Brand Sans fallback"');
		// The metric-matched fallback name lands in the font stack.
		expect(theme.styleCss).toContain('"Brand Sans fallback"');
		expect(theme.fontLinks).toEqual([]);
	});

	it("managed assets win over a same-named stored asset", () => {
		const stored = { faces: [{ url: "/old.woff2" }] };
		const managedAsset = { faces: [{ url: "/new.woff2", weight: 700 }] };
		const theme = presentTheme(
			managedRow({
				delivery: "self-host",
				assets: { "Brand Sans": stored },
				sources: { sans: { providerId: 3, family: "Brand Sans" } },
			}),
			{
				managed: [
					{
						providerId: 3,
						family: "Brand Sans",
						kind: "local",
						weights: [],
						asset: managedAsset,
					},
				],
			},
		);
		expect(theme.fontFaceCss).toContain("/new.woff2");
		expect(theme.fontFaceCss).not.toContain("/old.woff2");
	});

	it("managed entries for unreferenced sources are ignored", () => {
		const theme = presentTheme(managedRow({ delivery: "self-host", families: { sans: "Inter" } }), {
			managed: [{ providerId: 7, family: "Inter", kind: "googlefonts", weights: [400] }],
		});
		expect(theme.fontLinks).toEqual([]);
		expect(theme.styleCss).toContain('"Inter"');
	});

	it("a declared source with no matching managed entry keeps the free-form family", () => {
		const theme = presentTheme(
			managedRow({
				delivery: "self-host",
				families: { sans: "Free Sans" },
				sources: { sans: { providerId: 7, family: "Inter" } },
			}),
			// The catalog matched a different provider/family — the
			// (providerId, family) lookup misses and the slot falls back.
			{
				managed: [{ providerId: 9, family: "Other", kind: "googlefonts", weights: [400] }],
			},
		);
		expect(theme.fontLinks).toEqual([]);
		expect(theme.styleCss).toContain('"Free Sans"');
	});

	it("self-host managed sources without a resolved asset keep the bare family", () => {
		const theme = presentTheme(
			managedRow({
				delivery: "self-host",
				sources: { sans: { providerId: 3, family: "Brand Sans" } },
			}),
			// kind "local" but asset resolution found nothing — the slot
			// name still applies, no @font-face is emitted.
			{ managed: [{ providerId: 3, family: "Brand Sans", kind: "local", weights: [] }] },
		);
		expect(theme.styleCss).toContain('"Brand Sans"');
		expect(theme.fontFaceCss).toBe("");
		expect(theme.fontLinks).toEqual([]);
	});

	it("managed fonts with empty weights fall back to the default list", () => {
		const theme = presentTheme(
			managedRow({
				delivery: "self-host",
				sources: { sans: { providerId: 7, family: "Inter" } },
			}),
			{ managed: [{ providerId: 7, family: "Inter", kind: "googlefonts", weights: [] }] },
		);
		expect(theme.fontLinks[0]).toContain("wght@400;500;600;700");
	});
});
