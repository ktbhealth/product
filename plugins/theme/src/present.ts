/**
 * Row → wire presentation (P-082): turns a `theme_definitions` row
 * into the serializable `ResolvedTheme` shells consume — derived
 * tokens, the `:root`/`.dark` style block, font delivery links and
 * `@font-face` rules. Pure and client-safe (palette math only), so
 * the admin UI reuses it for live preview.
 */

import { deriveThemeTokens, themeRadius, tokensToCss } from "./palette.ts";
import type { ResolvedTheme, ThemeBrand, ThemeFontConfig, ThemeSeeds } from "./types.ts";

/** Minimal row shape `presentTheme` reads — structurally compatible
 * with the drizzle `theme_definitions` select row. */
export interface ThemeDefinitionRow {
	readonly id: number;
	readonly scope: string;
	readonly scopeId: string;
	readonly appName: string | null;
	readonly seeds: string;
	readonly tokens: string;
	readonly fonts: string | null;
	readonly brand: string | null;
	readonly enabled: boolean;
	readonly version: number;
}

const parseJson = <T>(text: string | null, fallback: T): T => {
	if (text === null) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
};

/** Config columns must be JSON objects — `[]`/`"x"`/`5` parse fine but
 * are not valid seeds/fonts/brand payloads. */
const asConfigObject = <T extends object>(value: T | null): T | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;

const FONT_FALLBACKS = {
	sans: "ui-sans-serif, system-ui, -apple-system, sans-serif",
	heading: "ui-sans-serif, system-ui, -apple-system, sans-serif",
	mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/** CSS font-family stack for a configured family name. */
const fontStack = (family: string | null | undefined, fallback: string): string =>
	family === null || family === undefined || family.trim() === ""
		? fallback
		: `"${family.trim().replaceAll('"', "")}", ${fallback}`;

/**
 * Font custom properties riding the `:root` block. Both the semantic
 * slots (`--font-sans`…) and the ui package's geist aliases are set so
 * every consumption path (`@theme inline` utilities AND the base-layer
 * `--font-geist*` vars) picks the theme font up.
 */
export const fontCssVars = (fonts: ThemeFontConfig | null): Record<string, string> => {
	if (fonts === null) return {};
	const families = fonts.families ?? {};
	const sans = fontStack(families.sans, FONT_FALLBACKS.sans);
	const heading = fontStack(families.heading ?? families.sans, FONT_FALLBACKS.heading);
	const mono = fontStack(families.mono, FONT_FALLBACKS.mono);
	return {
		"--font-sans": sans,
		"--font-heading": heading,
		"--font-mono": mono,
		"--font-body": sans,
		"--font-geist": sans,
		"--font-geist-mono": mono,
	};
};

/** Google Fonts stylesheet hrefs for a font config — only when the
 * theme opts into `google-fonts` delivery. One css2 URL per distinct
 * family with the configured weights (default 400;500;600;700). */
export const googleFontLinks = (fonts: ThemeFontConfig | null): readonly string[] => {
	if (fonts === null || fonts.delivery !== "google-fonts") return [];
	const families = fonts.families ?? {};
	const names = [
		...new Set(
			[families.sans, families.heading, families.mono].filter(
				(f): f is string => typeof f === "string" && f.trim() !== "",
			),
		),
	];
	const weights = (fonts.weights ?? [400, 500, 600, 700])
		.filter((w) => Number.isInteger(w) && w >= 100 && w <= 900)
		.sort((a, b) => a - b)
		.join(";");
	return names.map(
		(name) =>
			`https://fonts.googleapis.com/css2?family=${encodeURIComponent(name.trim().replaceAll(" ", "+"))}:wght@${weights}&display=swap`,
	);
};

/**
 * `@font-face` rules for self-hosted delivery. Phase 4 fills
 * `fonts.assets` (family → file URL/ref) via the async asset pipeline;
 * until then this returns "" and the shell emits nothing — graceful by
 * construction.
 */
export const fontFaceCss = (fonts: ThemeFontConfig | null): string => {
	if (fonts === null || fonts.delivery !== "self-host") return "";
	const assets = fonts.assets ?? {};
	const rules: string[] = [];
	for (const [family, url] of Object.entries(assets)) {
		if (typeof url !== "string" || url.trim() === "") continue;
		rules.push(
			`@font-face{font-family:"${family.replaceAll('"', "")}";src:url("${url}") format("woff2");font-display:swap;}`,
		);
	}
	return rules.join("\n");
};

/**
 * The complete `:root`/`.dark` override block for a resolved theme:
 * derived tokens + radius + font vars (scheme-independent, `:root`
 * only). Stored `tokens` JSON on the row is ignored — seeds are the
 * source of truth so the palette engine can never drift from stored
 * output.
 */
export const themeStyleCss = (theme: {
	readonly seeds: ThemeSeeds;
	readonly fonts: ThemeFontConfig | null;
}): string =>
	tokensToCss(deriveThemeTokens(theme.seeds), {
		"--radius": themeRadius(theme.seeds),
		...fontCssVars(theme.fonts),
	});

/**
 * Present a `theme_definitions` row as a `ResolvedTheme`. Invalid JSON
 * columns degrade to empty config rather than failing the request —
 * a malformed row must never take down a shell.
 */
export const presentTheme = (
	row: ThemeDefinitionRow,
	options?: { readonly preview?: boolean },
): ResolvedTheme => {
	const seeds = asConfigObject(parseJson<ThemeSeeds | null>(row.seeds, null)) ?? {};
	const fonts = asConfigObject(parseJson<ThemeFontConfig | null>(row.fonts, null));
	const brand = asConfigObject(parseJson<ThemeBrand | null>(row.brand, null));
	// The stored `tokens` JSON is kept for inspection only — resolution
	// re-derives from seeds so the palette engine stays authoritative
	// (see themeStyleCss).
	return {
		id: row.id,
		scope: row.scope as ResolvedTheme["scope"],
		scopeId: row.scopeId,
		appName: row.appName ?? brand?.appName ?? null,
		seeds,
		tokens: deriveThemeTokens(seeds),
		styleCss: themeStyleCss({ seeds, fonts }),
		fonts,
		fontLinks: googleFontLinks(fonts),
		fontFaceCss: fontFaceCss(fonts),
		brand,
		...(options?.preview === true ? { preview: true as const } : {}),
	};
};
