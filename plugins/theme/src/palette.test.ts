import { describe, expect, it } from "vitest";

import {
	CONTRAST_PAIRS,
	contrastRatio,
	contrastReport,
	deriveThemeTokens,
	ensureContrast,
	ensurePair,
	formatOklch,
	measurePair,
	parseColor,
	relativeLuminance,
	srgbToOklch,
	tokensToCss,
	themeRadius,
	type Oklch,
} from "./palette.ts";

const BLACK: Oklch = { l: 0, c: 0, h: 0 };
const WHITE: Oklch = { l: 1, c: 0, h: 0 };

describe("oklch math", () => {
	it("srgbToOklch round-trips known colors", () => {
		// Pure white → L≈1, chroma≈0.
		const white = srgbToOklch(255, 255, 255);
		expect(white.l).toBeGreaterThan(0.99);
		expect(white.c).toBeLessThan(0.01);
		const black = srgbToOklch(0, 0, 0);
		expect(black.l).toBeLessThan(0.01);
	});

	it("contrastRatio is symmetric and bounded 1..21", () => {
		const ratio = contrastRatio(BLACK, WHITE);
		expect(ratio).toBeCloseTo(21, 0);
		expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(ratio, 5);
		expect(contrastRatio(BLACK, BLACK)).toBeCloseTo(1, 5);
	});

	it("relativeLuminance orders black < white", () => {
		expect(relativeLuminance(BLACK)).toBeLessThan(relativeLuminance(WHITE));
	});
});

describe("parseColor", () => {
	it("parses hex, oklch and rgb", () => {
		expect(parseColor("#ffffff")).not.toBeNull();
		expect(parseColor("#fff")).not.toBeNull();
		expect(parseColor("oklch(0.5 0.1 250)")).toEqual({ l: 0.5, c: 0.1, h: 250 });
		expect(parseColor("oklch(50% 0.1 250)")?.l).toBeCloseTo(0.5, 5);
		expect(parseColor("rgb(255, 0, 0)")).not.toBeNull();
		expect(parseColor("rgba(0,0,0,0.5)")).not.toBeNull();
	});

	it("rejects garbage and empty input", () => {
		expect(parseColor("")).toBeNull();
		expect(parseColor(null)).toBeNull();
		expect(parseColor(undefined)).toBeNull();
		expect(parseColor("not-a-color")).toBeNull();
		expect(parseColor("#12")).toBeNull();
		expect(parseColor("oklch(0.5)")).toBeNull();
		expect(parseColor("hsl(120, 50%, 50%)")).toBeNull();
	});
});

describe("ensureContrast / ensurePair", () => {
	it("returns fg unchanged when already compliant", () => {
		const fg = { l: 0.2, c: 0, h: 0 };
		expect(ensureContrast(fg, WHITE, 4.5)).toEqual(fg);
	});

	it("darkens a too-light foreground on a light background", () => {
		const fg = { l: 0.9, c: 0, h: 0 };
		const fixed = ensureContrast(fg, WHITE, 4.5);
		expect(contrastRatio(fixed, WHITE)).toBeGreaterThanOrEqual(4.5);
		expect(fixed.l).toBeLessThan(fg.l);
	});

	it("lightens a too-dark foreground on a dark background", () => {
		const fg = { l: 0.1, c: 0, h: 0 };
		const fixed = ensureContrast(fg, BLACK, 4.5);
		expect(contrastRatio(fixed, BLACK)).toBeGreaterThanOrEqual(4.5);
		expect(fixed.l).toBeGreaterThan(fg.l);
	});

	it("ensurePair guarantees an AA on-color for any brand fill", () => {
		for (const l of [0.2, 0.45, 0.55, 0.7]) {
			const { bg, fg } = ensurePair({ l, c: 0.15, h: 250 }, 4.5);
			expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
		}
	});
});

describe("deriveThemeTokens", () => {
	it("emits the full semantic var set for both schemes", () => {
		const tokens = deriveThemeTokens({});
		for (const scheme of ["light", "dark"] as const) {
			const vars = tokens[scheme];
			for (const name of [
				"--background",
				"--foreground",
				"--card",
				"--card-foreground",
				"--primary",
				"--primary-foreground",
				"--secondary",
				"--secondary-foreground",
				"--muted",
				"--muted-foreground",
				"--accent",
				"--accent-foreground",
				"--destructive",
				"--border",
				"--input",
				"--ring",
				"--chart-1",
				"--chart-5",
				"--sidebar",
				"--sidebar-foreground",
				"--sidebar-primary",
				"--sidebar-primary-foreground",
				"--sidebar-accent",
				"--sidebar-accent-foreground",
				"--sidebar-border",
				"--sidebar-ring",
			]) {
				expect(vars[name], `${scheme} ${name}`).toMatch(/^oklch\(/);
			}
		}
	});

	it("empty seeds reproduce a valid default palette", () => {
		const tokens = deriveThemeTokens({});
		expect(parseColor(tokens.light["--primary"])).not.toBeNull();
		expect(parseColor(tokens.dark["--primary"])).not.toBeNull();
	});

	it("seeded primary shifts hue across both schemes", () => {
		const red = deriveThemeTokens({ primary: "#e11d48" });
		const blue = deriveThemeTokens({ primary: "#2563eb" });
		const redPrimary = parseColor(red.light["--primary"])!;
		const bluePrimary = parseColor(blue.light["--primary"])!;
		expect(redPrimary.h).not.toBeCloseTo(bluePrimary.h, 0);
	});

	it("dark scheme derives from the same seeds (lightness lifted)", () => {
		const tokens = deriveThemeTokens({ primary: "#2563eb" });
		const light = parseColor(tokens.light["--primary"])!;
		const dark = parseColor(tokens.dark["--primary"])!;
		expect(dark.h).toBeCloseTo(light.h, 0);
		expect(dark.l).toBeGreaterThan(light.l);
	});

	it("dark seed overrides apply only to the dark scheme", () => {
		const tokens = deriveThemeTokens({
			primary: "#2563eb",
			dark: { primary: "#f97316" },
		});
		const light = parseColor(tokens.light["--primary"])!;
		const dark = parseColor(tokens.dark["--primary"])!;
		// Orange hue (~50°) vs blue (~250°).
		expect(dark.h).toBeLessThan(120);
		expect(light.h).toBeGreaterThan(200);
	});

	it("invalid seed strings fall back instead of failing", () => {
		const tokens = deriveThemeTokens({ primary: "garbage", background: "#zzz" });
		expect(parseColor(tokens.light["--primary"])).not.toBeNull();
		expect(parseColor(tokens.light["--background"])).not.toBeNull();
	});

	it("every foreground pairing meets its AA floor in both schemes", () => {
		for (const seeds of [
			{},
			{ primary: "#e11d48" },
			{ primary: "#facc15", background: "#fef9c3" }, // nasty light-on-light
			{ primary: "#7c3aed", accent: "#0ea5e9" },
		]) {
			const tokens = deriveThemeTokens(seeds);
			for (const scheme of ["light", "dark"] as const) {
				for (const pair of CONTRAST_PAIRS) {
					const measured = measurePair(tokens, scheme, pair.name, pair.fg, pair.bg, pair.min);
					expect(
						measured.ok,
						`${JSON.stringify(seeds)} ${scheme} ${pair.name}: ${measured.ratio} < ${pair.min}`,
					).toBe(true);
				}
			}
		}
	});

	it("contrastReport covers every declared pair per scheme", () => {
		const tokens = deriveThemeTokens({});
		expect(contrastReport(tokens, "light")).toHaveLength(CONTRAST_PAIRS.length);
		expect(contrastReport(tokens, "dark")).toHaveLength(CONTRAST_PAIRS.length);
	});
});

describe("tokensToCss / themeRadius", () => {
	it("serializes :root and .dark blocks", () => {
		const css = tokensToCss(deriveThemeTokens({ primary: "#2563eb" }));
		expect(css).toContain(":root{");
		expect(css).toContain(".dark{");
		expect(css).toContain("--primary:oklch(");
	});

	it("extraRoot vars land in :root only", () => {
		const css = tokensToCss(deriveThemeTokens({}), { "--font-sans": "Inter" });
		const [root, dark] = css.split("\n");
		expect(root).toContain("--font-sans:Inter");
		expect(dark).not.toContain("--font-sans");
	});

	it("themeRadius defaults and passes through", () => {
		expect(themeRadius({})).toBe("0.45rem");
		expect(themeRadius({ radius: "0.8rem" })).toBe("0.8rem");
		expect(themeRadius({ radius: "  " })).toBe("0.45rem");
	});

	it("formatOklch emits valid css", () => {
		expect(formatOklch({ l: 0.5, c: 0.1, h: 250 })).toMatch(/^oklch\(/);
	});
});
