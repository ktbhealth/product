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
		expect(parseColor("#12345")).toBeNull();
		expect(parseColor("#ggg")).toBeNull();
		expect(parseColor("oklch(0.5)")).toBeNull();
		expect(parseColor("hsl(120, 50%, 50%)")).toBeNull();
	});

	it("parses oklab including percent lightness", () => {
		const lab = parseColor("oklab(0.5 0.1 -0.05)");
		expect(lab).not.toBeNull();
		expect(lab!.l).toBeGreaterThan(0);
		expect(lab!.l).toBeLessThan(1);
		expect(parseColor("oklab(50% 0.1 -0.05)")).not.toBeNull();
	});

	it("parses rgb with percent channels", () => {
		expect(parseColor("rgb(100%, 0%, 0%)")).not.toBeNull();
		// Unparseable percent channel falls back to 0 instead of null.
		expect(parseColor("rgb(a%, 0%, 0%)")).not.toBeNull();
	});

	it("rejects malformed functional colors", () => {
		// Enough args but non-numeric channels.
		expect(parseColor("oklch(x 0.1 250)")).toBeNull();
		expect(parseColor("oklch(0.5 x 250)")).toBeNull();
		expect(parseColor("oklch(0.5 0.1 x)")).toBeNull();
		expect(parseColor("oklch(NaN 0.1 250)")).toBeNull();
		expect(parseColor("oklab(0.5)")).toBeNull();
		expect(parseColor("oklab(x 0.1 0.2)")).toBeNull();
		expect(parseColor("oklab(0.5 x 0.2)")).toBeNull();
		expect(parseColor("rgb(a, b, c)")).toBeNull();
		expect(parseColor("rgb(1, 2)")).toBeNull();
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

	it("ensureContrast walks toward the darker extreme when it contrasts better", () => {
		// Two light surfaces: only darkening the fg can reach AA.
		const fixed = ensureContrast({ l: 0.9, c: 0, h: 0 }, { l: 0.85, c: 0, h: 0 }, 4.5);
		expect(contrastRatio(fixed, { l: 0.85, c: 0, h: 0 })).toBeGreaterThanOrEqual(4.5);
		expect(fixed.l).toBeLessThan(0.9);
	});

	it("ensurePair walks the fill away from the preferred fg in dead zones", () => {
		// min=99 can never pass → each side walks to its bound and the
		// loop breaks, returning the better extreme.
		const dark = ensurePair({ l: 0.3, c: 0, h: 0 }, 99);
		expect(dark.fg).toEqual(WHITE);
		const light = ensurePair({ l: 0.8, c: 0, h: 0 }, 99);
		// INK is the module-private { l: 0.22, c: 0, h: 0 } extreme.
		expect(light.fg).toEqual({ l: 0.22, c: 0, h: 0 });
	});

	it("ensureContrast sheds chroma and returns the best extreme in the dead zone", () => {
		// bg luminance ~0.178 sits in the narrow band where BOTH pure
		// black and pure white fall just under the 4.6 target — no
		// lightness passes even with chroma fully shed.
		const bg = { l: 0.563, c: 0, h: 0 };
		const fixed = ensureContrast({ l: 0.5, c: 0.2, h: 30 }, bg, 4.5);
		expect(fixed.l === 0 || fixed.l === 1 || fixed.c === 0).toBe(true);
	});

	it("ensurePair moves the fill until an on-color passes", () => {
		// Mid-gray fill: neither white nor ink reaches AA until the
		// lightness is nudged toward the ink side.
		const { bg, fg } = ensurePair({ l: 0.6, c: 0, h: 0 }, 4.5);
		expect(bg.l).toBeGreaterThan(0.6);
		expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
	});

	it("ensurePair falls back to the better on-color at the lightness bound", () => {
		// Saturated near-white fill: even l=1 cannot reach AA, so the
		// loop hits the upper bound and returns the better extreme.
		const { bg, fg } = ensurePair({ l: 1, c: 0.5, h: 30 }, 4.5);
		expect(bg.l).toBe(1);
		expect(fg.l).toBe(0.22);
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

	it("measurePair reports ratio 0 and failure for unparseable vars", () => {
		const tokens = deriveThemeTokens({});
		const pair = measurePair(tokens, "light", "missing", "--nope", "--background");
		expect(pair.ratio).toBe(0);
		expect(pair.ok).toBe(false);
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
