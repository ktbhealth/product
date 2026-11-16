/**
 * Theme token engine (P-082): pure functions turning admin-authored
 * seed colors into the full shadcn/Tailwind-v4 CSS custom-property
 * set that `@ktbhealth/ui`'s globals.css consumes.
 *
 * Accessibility is enforced by construction: authors supply SEEDS
 * (hues/surface preferences), never foreground pairs — every
 * `*-foreground` is derived and WCAG-AA-clamped (4.5:1 body text,
 * 3:1 for the focus ring), and `.dark` is generated from the same
 * seeds so the two schemes cannot drift. All math is OKLCH↔sRGB with
 * WCAG relative-luminance contrast; no DOM, no env — trivially
 * testable to 100%.
 */

import type { ThemeSeeds, ThemeTokens } from "./types.ts";

// ---------- OKLCH color math (Björn Ottosson matrices) ----------

export interface Oklch {
	readonly l: number;
	readonly c: number;
	readonly h: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const srgbToLinear = (v: number) => {
	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/** OKLab → linear sRGB (clamped). */
export const oklchToLinearRgb = ({ l, c, h }: Oklch): readonly [number, number, number] => {
	const hr = (h * Math.PI) / 180;
	const a = c * Math.cos(hr);
	const b = c * Math.sin(hr);
	const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = l - 0.0894841775 * a - 1.291485548 * b;
	const lc = l_ ** 3;
	const mc = m_ ** 3;
	const sc = s_ ** 3;
	return [
		clamp01(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
		clamp01(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
		clamp01(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
	];
};

/** linear sRGB → OKLab → OKLCH. */
export const linearRgbToOklch = (rgb: readonly [number, number, number]): Oklch => {
	const [r, g, b] = rgb;
	const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
	const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
	const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
	return {
		l: clamp01(L),
		c: Math.max(0, Math.hypot(A, B)),
		h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360,
	};
};

/** sRGB (0-255 encoded) → OKLCH. */
export const srgbToOklch = (r: number, g: number, b: number): Oklch =>
	linearRgbToOklch([srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]);

/** WCAG 2.x relative luminance of an OKLCH color. */
export const relativeLuminance = ({ l, c, h }: Oklch): number => {
	const [r, g, b] = oklchToLinearRgb({ l, c, h });
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two OKLCH colors (1–21). */
export const contrastRatio = (a: Oklch, b: Oklch): number => {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
};

// ---------- color parsing / formatting ----------

const num = (v: string): number | null => {
	const n = Number.parseFloat(v);
	return Number.isFinite(n) ? n : null;
};

const splitArgs = (body: string): readonly string[] =>
	body
		.split(/[\s,/]+/)
		.map((s) => s.trim())
		.filter((s) => s !== "");

/**
 * Parse a CSS color into OKLCH. Supported: `#rgb`/`#rrggbb`/`#rrggbbaa`,
 * `oklch(L C H [/ A])` (L as number or %), `oklab(L a b)`,
 * `rgb()/rgba()` (0-255 or %). Anything else → null (caller falls
 * back to the theme default).
 */
export const parseColor = (input: string | null | undefined): Oklch | null => {
	if (input === null || input === undefined) return null;
	const s = input.trim().toLowerCase();
	if (s === "") return null;
	if (s.startsWith("#")) {
		const hex = s.slice(1);
		const full =
			hex.length === 3
				? hex
						.split("")
						.map((ch) => ch + ch)
						.join("")
				: hex.length >= 6
					? hex.slice(0, 6)
					: "";
		if (!/^[0-9a-f]{6}$/.test(full)) return null;
		return srgbToOklch(
			Number.parseInt(full.slice(0, 2), 16),
			Number.parseInt(full.slice(2, 4), 16),
			Number.parseInt(full.slice(4, 6), 16),
		);
	}
	const fn = /^([a-z]+)\((.*)\)$/.exec(s);
	if (fn === null) return null;
	const [, name, body] = fn;
	const args = splitArgs(/* v8 ignore next -- (.*) always participates */ body ?? "");
	if (name === "oklch" && args.length >= 3) {
		const lRaw = args[0]!;
		const l = lRaw.endsWith("%") ? num(lRaw.slice(0, -1))! / 100 : num(lRaw);
		const c = num(args[1]!);
		const h = num(args[2]!);
		if (l === null || c === null || h === null || Number.isNaN(l)) return null;
		return { l: clamp01(l), c: Math.max(0, c), h: ((h % 360) + 360) % 360 };
	}
	if (name === "oklab" && args.length >= 3) {
		const lRaw = args[0]!;
		const l = lRaw.endsWith("%") ? num(lRaw.slice(0, -1))! / 100 : num(lRaw);
		const a = num(args[1]!);
		const b = num(args[2]!);
		if (l === null || a === null || b === null || Number.isNaN(l)) return null;
		const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
		const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
		const s_ = l - 0.0894841775 * a - 1.291485548 * b;
		return linearRgbToOklch([
			clamp01(4.0767416621 * l_ ** 3 - 3.3077115913 * m_ ** 3 + 0.2309699292 * s_ ** 3),
			clamp01(-1.2684380046 * l_ ** 3 + 2.6097574011 * m_ ** 3 - 0.3413193965 * s_ ** 3),
			clamp01(-0.0041960863 * l_ ** 3 - 0.7034186147 * m_ ** 3 + 1.707614701 * s_ ** 3),
		]);
	}
	if ((name === "rgb" || name === "rgba") && args.length >= 3) {
		const channel = (v: string): number | null =>
			v.endsWith("%") ? (num(v.slice(0, -1)) ?? 0) * 2.55 : num(v);
		const r = channel(args[0]!);
		const g = channel(args[1]!);
		const b = channel(args[2]!);
		if (r === null || g === null || b === null) return null;
		return srgbToOklch(r, g, b);
	}
	return null;
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Format an OKLCH color as a CSS `oklch(L C H)` string. L keeps 3
 * decimals — 2-decimal rounding can drop a just-passing foreground
 * below its AA floor after serialization. */
export const formatOklch = ({ l, c, h }: Oklch): string =>
	`oklch(${r3(clamp01(l))} ${r3(Math.max(0, c))} ${r2(((h % 360) + 360) % 360)})`;

// ---------- contrast enforcement ----------

/**
 * Adjust `fg`'s lightness (hue/chroma preserved) until it reaches
 * `min` contrast against `bg`. Walks from the current lightness toward
 * the contrasting extreme in 0.01 steps and keeps the closest passing
 * value — deterministic and bounded. If even the extreme fails, the
 * extreme is returned.
 */
export const ensureContrast = (fg: Oklch, bg: Oklch, min = 4.5): Oklch => {
	// +0.1 headroom: the walk stops at the FIRST passing lightness, so
	// the result sits exactly on the boundary — CSS serialization
	// rounding must never push it back under `min`.
	const target = min + 0.1;
	if (contrastRatio(fg, bg) >= target) return fg;
	// Walk toward whichever extreme (l=0 or l=1) contrasts better with
	// bg — bg luminance alone misleads on saturated mid-lightness
	// surfaces, so compare the two extremes directly. If even the
	// extreme fails (saturated fg keeps chroma at the lightness floor),
	// shed chroma progressively — contrast beats hue fidelity for
	// text.
	for (const chromaScale of [1, 0.5, 0]) {
		const base = { ...fg, c: fg.c * chromaScale };
		const darkExtreme = { ...base, l: 0 };
		const lightExtreme = { ...base, l: 1 };
		const towardDark = contrastRatio(darkExtreme, bg) >= contrastRatio(lightExtreme, bg);
		const step = towardDark ? -0.01 : 0.01;
		let best = towardDark ? darkExtreme : lightExtreme;
		for (let l = base.l + step; towardDark ? l >= 0 : l <= 1; l += step) {
			const candidate = { ...base, l };
			if (contrastRatio(candidate, bg) >= target) return candidate;
		}
		// No passing lightness at this chroma — keep the best extreme
		// and try shedding more chroma.
		if (chromaScale === 0) return best;
	}
	/* v8 ignore next -- the chromaScale === 0 iteration always returns above */
	return fg;
};

const WHITE: Oklch = { l: 1, c: 0, h: 0 };
const INK: Oklch = { l: 0.22, c: 0, h: 0 };

/**
 * Pick the accessible foreground for a filled `bg` (buttons, badges):
 * white or ink, whichever contrasts more. When NEITHER reaches `min`
 * (mid-lightness brand colors), `bg`'s lightness is moved toward the
 * better side until the pair passes — the returned `bg` is the
 * auto-corrected fill and `fg` its compliant foreground.
 */
export const ensurePair = (bg: Oklch, min = 4.5): { readonly bg: Oklch; readonly fg: Oklch } => {
	// Same serialization headroom as ensureContrast — the emitted CSS
	// rounds to 3 decimals and must stay >= min after rounding.
	const target = min + 0.1;
	let current = bg;
	for (let i = 0; i < 100; i++) {
		const whiteRatio = contrastRatio(WHITE, current);
		const inkRatio = contrastRatio(INK, current);
		const useWhite = whiteRatio >= inkRatio;
		const ratio = useWhite ? whiteRatio : inkRatio;
		if (ratio >= target) return { bg: current, fg: useWhite ? WHITE : INK };
		// Move bg away from the chosen fg: darken for white text,
		// lighten for ink.
		const next = useWhite ? current.l - 0.01 : current.l + 0.01;
		if ((useWhite && next < 0) || (!useWhite && next > 1)) break;
		current = { ...current, l: next };
	}
	const whiteRatio = contrastRatio(WHITE, current);
	const inkRatio = contrastRatio(INK, current);
	return whiteRatio >= inkRatio ? { bg: current, fg: WHITE } : { bg: current, fg: INK };
};

// ---------- seed → token derivation ----------

/** Stock KTB palette anchors — used whenever a seed is absent, so a
 * theme with no seeds reproduces the ui defaults exactly. */
const FALLBACK: Oklch = { l: 0.5, c: 0.11, h: 259.02 };

const seed = (value: string | undefined, fallback: Oklch): Oklch => parseColor(value) ?? fallback;

const NEUTRAL = (l: number, c: number, h: number): Oklch => ({ l, c, h });

interface ModeAnchors {
	/** Background surface lightness/chroma target. */
	readonly bg: Oklch;
	/** Default foreground. */
	readonly fg: Oklch;
	/** Card/popover surface. */
	readonly card: Oklch;
	/** Muted surface + its default fg candidate. */
	readonly muted: Oklch;
	readonly mutedFg: Oklch;
	/** Secondary surface + fg candidate. */
	readonly secondary: Oklch;
	readonly secondaryFg: Oklch;
	/** Accent surface + fg candidate. */
	readonly accent: Oklch;
	readonly accentFg: Oklch;
	/** Border/input surface. */
	readonly border: Oklch;
	/** Default destructive. */
	readonly destructive: Oklch;
	/** Chart hues as offsets from primary. */
	readonly chartOffsets: readonly number[];
	/** Sidebar family. */
	readonly sidebar: Oklch;
	readonly sidebarAccent: Oklch;
}

const LIGHT_ANCHORS: ModeAnchors = {
	bg: NEUTRAL(1, 0, 0),
	fg: NEUTRAL(0.32, 0, 0),
	card: NEUTRAL(1, 0, 0),
	muted: NEUTRAL(0.98, 0, 0),
	mutedFg: NEUTRAL(0.55, 0.02, 264.41),
	secondary: NEUTRAL(0.97, 0, 0),
	secondaryFg: NEUTRAL(0.45, 0.03, 257.68),
	accent: NEUTRAL(0.95, 0.03, 233.56),
	accentFg: NEUTRAL(0.38, 0.14, 265.59),
	border: NEUTRAL(0.93, 0.01, 261.82),
	destructive: { l: 0.64, c: 0.21, h: 25.39 },
	chartOffsets: [0, 30, 60, 160, 220],
	sidebar: NEUTRAL(0.98, 0, 0),
	sidebarAccent: NEUTRAL(0.97, 0, 0),
};

const DARK_ANCHORS: ModeAnchors = {
	bg: NEUTRAL(0.2, 0, 0),
	fg: NEUTRAL(0.92, 0, 0),
	card: NEUTRAL(0.27, 0, 0),
	muted: NEUTRAL(0.27, 0, 0),
	mutedFg: NEUTRAL(0.72, 0, 0),
	secondary: NEUTRAL(0.27, 0, 0),
	secondaryFg: NEUTRAL(0.92, 0, 0),
	accent: NEUTRAL(0.38, 0.14, 265.59),
	accentFg: NEUTRAL(0.88, 0.06, 254.63),
	border: NEUTRAL(0.37, 0, 0),
	destructive: { l: 0.64, c: 0.21, h: 25.39 },
	chartOffsets: [0, 30, 60, 160, 220],
	sidebar: NEUTRAL(0.21, 0.01, 285.93),
	sidebarAccent: NEUTRAL(0.27, 0.01, 286.1),
};

/** Derive one scheme's full var map. */
const buildMode = (
	anchors: ModeAnchors,
	input: {
		readonly primary: Oklch;
		readonly secondary?: string;
		readonly accent?: string;
		readonly background?: string;
		readonly foreground?: string;
		readonly destructive?: string;
	},
	dark: boolean,
): Record<string, string> => {
	const h = input.primary.h;
	const c = input.primary.c;
	// Surfaces pick up a whisper of the brand hue/chroma so themes feel
	// cohesive without ever competing with content contrast.
	const tint = (l: number, chromaScale: number): Oklch =>
		NEUTRAL(l, Math.min(c * chromaScale, dark ? 0.02 : 0.012), h);

	const background = seed(input.background, tint(anchors.bg.l, 0.15));
	const foreground = ensureContrast(seed(input.foreground, anchors.fg), background, 7);
	const card = dark ? tint(anchors.card.l, 0.1) : background;
	const cardForeground = ensureContrast(foreground, card, 7);
	const secondary = seed(input.secondary, tint(anchors.secondary.l, 0.4));
	const secondaryForeground = ensureContrast(seed(undefined, anchors.secondaryFg), secondary, 4.5);
	const muted = tint(anchors.muted.l, 0.2);
	const mutedForeground = ensureContrast(seed(undefined, anchors.mutedFg), muted, 4.5);
	const accent = seed(input.accent, tint(anchors.accent.l, 0.6));
	const accentForeground = ensureContrast(seed(undefined, anchors.accentFg), accent, 4.5);
	const destructive = seed(input.destructive, anchors.destructive);
	const border = tint(anchors.border.l, 0.15);

	// Brand color + its compliant on-color. ensurePair may nudge
	// primary's lightness when no white/ink reaches AA — the corrected
	// value is what ships so foreground contrast is guaranteed.
	const primaryPair = ensurePair(input.primary, 4.5);
	const primary = primaryPair.bg;
	const primaryForeground = primaryPair.fg;
	// Focus ring: primary with a 3:1 floor against BOTH background and
	// card — keyboard focus stays visible on any brand palette.
	const ringBase = ensureContrast(primary, background, 3);
	const ring = ensureContrast(ringBase, card, 3);

	const sidebar = tint(anchors.sidebar.l, 0.1);
	const sidebarForeground = ensureContrast(foreground, sidebar, 7);
	const sidebarPrimaryPair = ensurePair(primary, 4.5);
	const sidebarAccent = secondary;
	const sidebarAccentForeground = ensureContrast(secondaryForeground, sidebarAccent, 4.5);
	const sidebarBorder = tint(anchors.border.l + (dark ? 0.04 : -0.01), 0.1);
	const sidebarRing = ensureContrast(ring, sidebar, 3);

	const chart = (i: number): string =>
		formatOklch({
			l: dark ? Math.min(primary.l + 0.12, 0.8) : primary.l,
			c: Math.min(c * 0.85, 0.22),
			h: (h + anchors.chartOffsets[i]!) % 360,
		});

	return {
		"--background": formatOklch(background),
		"--foreground": formatOklch(foreground),
		"--card": formatOklch(card),
		"--card-foreground": formatOklch(cardForeground),
		"--popover": formatOklch(card),
		"--popover-foreground": formatOklch(cardForeground),
		"--primary": formatOklch(primary),
		"--primary-foreground": formatOklch(primaryForeground),
		"--secondary": formatOklch(secondary),
		"--secondary-foreground": formatOklch(secondaryForeground),
		"--muted": formatOklch(muted),
		"--muted-foreground": formatOklch(mutedForeground),
		"--accent": formatOklch(accent),
		"--accent-foreground": formatOklch(accentForeground),
		"--destructive": formatOklch(destructive),
		"--border": formatOklch(border),
		"--input": formatOklch(border),
		"--ring": formatOklch(ring),
		"--chart-1": chart(0),
		"--chart-2": chart(1),
		"--chart-3": chart(2),
		"--chart-4": chart(3),
		"--chart-5": chart(4),
		"--sidebar": formatOklch(sidebar),
		"--sidebar-foreground": formatOklch(sidebarForeground),
		"--sidebar-primary": formatOklch(primary),
		"--sidebar-primary-foreground": formatOklch(sidebarPrimaryPair.fg),
		"--sidebar-accent": formatOklch(sidebarAccent),
		"--sidebar-accent-foreground": formatOklch(sidebarAccentForeground),
		"--sidebar-border": formatOklch(sidebarBorder),
		"--sidebar-ring": formatOklch(sidebarRing),
	};
};

/**
 * Derive the full light+dark token maps from admin seeds. Every
 * `*-foreground` is AA-clamped against its surface; `--ring` keeps a
 * 3:1 floor vs background and card. Invalid/absent seeds fall back to
 * the stock KTB anchors per field.
 */
export const deriveThemeTokens = (seeds: ThemeSeeds): ThemeTokens => {
	const primary = seed(seeds.primary, FALLBACK);
	const light = buildMode(
		LIGHT_ANCHORS,
		{
			primary,
			secondary: seeds.secondary,
			accent: seeds.accent,
			background: seeds.background,
			foreground: seeds.foreground,
			destructive: seeds.destructive,
		},
		false,
	);
	// Dark mode derives from the SAME seeds: the primary is lifted to a
	// dark-appropriate lightness, surfaces flip to the dark anchors,
	// and per-scheme seed overrides apply on top.
	const darkSeeds = seeds.dark ?? {};
	const darkPrimary = liftForDark(primary);
	const dark = buildMode(
		DARK_ANCHORS,
		{
			primary: seed(darkSeeds.primary, darkPrimary),
			secondary: darkSeeds.secondary ?? seeds.secondary,
			accent: darkSeeds.accent ?? seeds.accent,
			background: darkSeeds.background ?? seeds.background,
			foreground: darkSeeds.foreground ?? seeds.foreground,
			destructive: seeds.destructive,
		},
		true,
	);
	return { light, dark };
};

/** Lift a brand color to a dark-scheme-appropriate lightness while
 * preserving hue and (clamped) chroma — the `.dark` block is generated,
 * never authored, so modes can't drift. */
const liftForDark = (primary: Oklch): Oklch =>
	NEUTRAL(
		Math.min(Math.max(primary.l + 0.1, 0.68), 0.85),
		Math.min(primary.c * 1.3, 0.25),
		primary.h,
	);

/** Serialize token maps into the `:root{…}` / `.dark{…}` override
 * block shells inject. `extraRoot` appends scheme-independent vars
 * (font stacks) to `:root` only — `.dark` inherits them. */
export const tokensToCss = (
	tokens: ThemeTokens,
	extraRoot?: Readonly<Record<string, string>>,
): string => {
	const block = (vars: Readonly<Record<string, string>>) =>
		`{${Object.entries(vars)
			.map(([k, v]) => `${k}:${v};`)
			.join("")}}`;
	const rootVars = extraRoot === undefined ? tokens.light : { ...tokens.light, ...extraRoot };
	return `:root${block(rootVars)}\n.dark${block(tokens.dark)}`;
};

/** Radius passthrough — validated non-empty, default stock value. */
export const themeRadius = (seeds: ThemeSeeds): string => {
	const r = seeds.radius?.trim();
	return r !== undefined && r !== "" ? r : "0.45rem";
};

/** One contrast-report row for the admin UI: a foreground/background
 * pairing with its measured ratio and AA verdict. */
export interface ContrastPair {
	readonly name: string;
	readonly ratio: number;
	readonly min: number;
	readonly ok: boolean;
}

/** Measure the WCAG ratio of a derived token pairing. Both sides are
 * parsed from the emitted CSS strings so the report reflects exactly
 * what ships. */
export const measurePair = (
	tokens: ThemeTokens,
	scheme: "light" | "dark",
	name: string,
	foregroundVar: string,
	backgroundVar: string,
	min = 4.5,
): ContrastPair => {
	const vars = tokens[scheme];
	const fg = parseColor(vars[foregroundVar]);
	const bg = parseColor(vars[backgroundVar]);
	const ratio = fg !== null && bg !== null ? contrastRatio(fg, bg) : 0;
	return { name, ratio: Math.round(ratio * 100) / 100, min, ok: ratio >= min };
};

/** The pairings the admin contrast report checks — every `*-foreground`
 * token against its surface, plus the 3:1 focus-ring floors. */
export const CONTRAST_PAIRS: readonly {
	readonly name: string;
	readonly fg: string;
	readonly bg: string;
	readonly min: number;
}[] = [
	{ name: "primary", fg: "--primary-foreground", bg: "--primary", min: 4.5 },
	{ name: "foreground", fg: "--foreground", bg: "--background", min: 4.5 },
	{ name: "card", fg: "--card-foreground", bg: "--card", min: 4.5 },
	{ name: "popover", fg: "--popover-foreground", bg: "--popover", min: 4.5 },
	{
		name: "secondary",
		fg: "--secondary-foreground",
		bg: "--secondary",
		min: 4.5,
	},
	{ name: "muted", fg: "--muted-foreground", bg: "--muted", min: 4.5 },
	{ name: "accent", fg: "--accent-foreground", bg: "--accent", min: 4.5 },
	{ name: "sidebar", fg: "--sidebar-foreground", bg: "--sidebar", min: 4.5 },
	{
		name: "sidebar-primary",
		fg: "--sidebar-primary-foreground",
		bg: "--sidebar-primary",
		min: 4.5,
	},
	{
		name: "sidebar-accent",
		fg: "--sidebar-accent-foreground",
		bg: "--sidebar-accent",
		min: 4.5,
	},
	{ name: "ring/background", fg: "--ring", bg: "--background", min: 3 },
	{ name: "ring/card", fg: "--ring", bg: "--card", min: 3 },
	{ name: "sidebar-ring", fg: "--sidebar-ring", bg: "--sidebar", min: 3 },
];

/** Full contrast report for one scheme (light or dark). */
export const contrastReport = (
	tokens: ThemeTokens,
	scheme: "light" | "dark",
): readonly ContrastPair[] =>
	CONTRAST_PAIRS.map((p) => measurePair(tokens, scheme, p.name, p.fg, p.bg, p.min));
