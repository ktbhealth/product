/**
 * Built-in platform-default theme (PL-006 phase 7): the KTB brand as a
 * `ResolvedTheme` constant. `Theme.resolve` returns it when no
 * `theme_definitions` row matches the scope chain, so branding lives in
 * theme data on fresh deploys with zero migrations — a real platform
 * row still wins because resolve checks the database first.
 *
 * Chosen over a DB seed/migration because it needs no migration, cannot
 * be deleted or disabled by an admin, and is identical in every
 * environment (dev, preview, prod). The `ui` token defaults in
 * globals.css remain the final CSS fallback — this theme merely
 * reproduces them.
 *
 * Palette: seeds carry the stock ui token values (`--primary`
 * oklch(0.62 0.11 259.02) light / oklch(0.62 0.19 259.76) dark). The
 * palette engine re-derives every `*-foreground` with WCAG clamps, so
 * on-colors may differ slightly from the hand-tuned ui tokens where
 * those fall below AA (e.g. primary-foreground becomes ink instead of
 * sub-AA white) — that is the engine working as designed.
 *
 * Fonts: the current Geist stack via `self-host` delivery with no asset
 * files yet — `fontFaceCss`/`fontLinks` stay empty and the emitted
 * `--font-*` vars match globals.css exactly. Phase 4's asset pipeline
 * fills `fonts.assets` later without touching this file.
 *
 * Brand: logo/wordmark/favicon point at the brand assets served from
 * `apps/web/public/brand/` (mirrors of `@ktbhealth/ui/brand` — kept as
 * static files because the TanStack route generator evaluates this
 * module through jiti, which cannot load `.svg`/`.png` `?url` imports;
 * plain string URLs are serializable and work identically under vite,
 * vitest and workerd). `id: 0`/`scopeId: ""` mark it as synthetic: it is
 * never a `theme_definitions` row and never appears in admin lists.
 */

import { deriveThemeTokens } from "./palette.ts";
import { fontFaceCss, googleFontLinks, themeStyleCss } from "./present.ts";
import type { ResolvedTheme, ThemeBrand, ThemeFontConfig, ThemeSeeds } from "./types.ts";

const logoHorizontal = "/brand/logo-horizontal.svg";
const logoHorizontalInverse = "/brand/logo-horizontal-inverse.svg";
const logoMark = "/brand/logo-mark.png";

/** Stock ui palette seeds — see header for the AA-clamp caveat. */
const KTB_SEEDS: ThemeSeeds = {
	primary: "oklch(0.62 0.11 259.02)",
	dark: { primary: "oklch(0.62 0.19 259.76)" },
};

/** Current font stack — Geist first, system fallbacks identical to
 * globals.css `--font-geist*`. */
const KTB_FONTS: ThemeFontConfig = {
	delivery: "self-host",
	families: { sans: "Geist", heading: "Geist", mono: "Geist Mono" },
	weights: [400, 500, 600, 700],
};

const KTB_BRAND: ThemeBrand = {
	appName: "KTB Health",
	logoLight: logoHorizontal,
	logoDark: logoHorizontalInverse,
	wordmark: logoHorizontal,
	favicon: logoMark,
	ogImage: null,
};

export const KTB_DEFAULT_THEME: ResolvedTheme = {
	// Synthetic id — `theme_definitions.id` starts at 1, so 0 can never
	// collide with a real row (admin preview/edit paths key on it).
	id: 0,
	scope: "platform",
	scopeId: "",
	appName: "KTB Health",
	seeds: KTB_SEEDS,
	tokens: deriveThemeTokens(KTB_SEEDS),
	styleCss: themeStyleCss({ seeds: KTB_SEEDS, fonts: KTB_FONTS }),
	fonts: KTB_FONTS,
	fontLinks: googleFontLinks(KTB_FONTS),
	fontFaceCss: fontFaceCss(KTB_FONTS),
	brand: KTB_BRAND,
};
