/**
 * Row → wire presentation (P-082): turns a `theme_definitions` row
 * into the serializable `ResolvedTheme` shells consume — derived
 * tokens, the `:root`/`.dark` style block, font delivery links and
 * `@font-face` rules. Pure and client-safe (palette math only), so
 * the admin UI reuses it for live preview.
 */

import { deriveThemeTokens, themeRadius, tokensToCss } from "./palette.ts";
import type {
	ResolvedTheme,
	ThemeBrand,
	ThemeFontAsset,
	ThemeFontAssetValue,
	ThemeFontConfig,
	ThemeFontFace,
	ThemeSeeds,
} from "./types.ts";

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

/** Metric-matched fallback face name recorded on a font asset —
 * inserted into the family stack right after the webfont so the
 * adjusted local() face absorbs the swap (Phase 4). */
const metricFallbackName = (
	fonts: ThemeFontConfig,
	family: string | null | undefined,
): string | null => {
	if (family === null || family === undefined || family.trim() === "") return null;
	const asset = fonts.assets?.[family.trim()];
	if (typeof asset !== "object" || asset === null) return null;
	const name = (asset as ThemeFontAsset).fallback?.name;
	return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
};

/** CSS font-family stack for a configured family name, including the
 * metric-matched fallback face when the font job recorded one. */
const fontStack = (
	fonts: ThemeFontConfig,
	family: string | null | undefined,
	fallback: string,
): string => {
	if (family === null || family === undefined || family.trim() === "") return fallback;
	const name = family.trim().replaceAll('"', "");
	const metricFallback = metricFallbackName(fonts, name);
	const middle = metricFallback === null ? "" : `"${metricFallback}", `;
	return `"${name}", ${middle}${fallback}`;
};

/**
 * Font custom properties riding the `:root` block. Both the semantic
 * slots (`--font-sans`…) and the ui package's geist aliases are set so
 * every consumption path (`@theme inline` utilities AND the base-layer
 * `--font-geist*` vars) picks the theme font up.
 */
export const fontCssVars = (fonts: ThemeFontConfig | null): Record<string, string> => {
	if (fonts === null) return {};
	const families = fonts.families ?? {};
	const sans = fontStack(fonts, families.sans, FONT_FALLBACKS.sans);
	const heading = fontStack(fonts, families.heading ?? families.sans, FONT_FALLBACKS.heading);
	const mono = fontStack(fonts, families.mono, FONT_FALLBACKS.mono);
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

const FONT_FORMATS: Readonly<Record<string, string>> = {
	woff2: "woff2",
	woff: "woff",
	ttf: "truetype",
	otf: "opentype",
};

const extOfUrl = (url: string): string => {
	const clean = url.split("#")[0]!;
	const base = clean.split("?")[0]!.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	if (dot !== -1) return base.slice(dot + 1).toLowerCase();
	// Serving URLs carry the object key in ?key= — the extension lives
	// there, not in the path.
	const key = /[?&]key=([^&]+)/.exec(clean)?.[1];
	if (key === undefined) return "";
	const k = decodeURIComponent(key);
	const kDot = k.lastIndexOf(".");
	return kDot === -1 ? "" : k.slice(kDot + 1).toLowerCase();
};

const escapeCssString = (value: string): string => value.replaceAll('"', "");

/** local() src list for a fallback face — family name plus the
 * `Regular`/`-Regular` spellings local() matching tries (fontaine). */
const localSrc = (local: string): string => {
	const names = [local, `${local} Regular`, `${local.replaceAll(/\s+/g, "")}-Regular`];
	return [...new Set(names)].map((n) => `local("${escapeCssString(n)}")`).join(", ");
};

const assetFaces = (value: ThemeFontAssetValue): readonly ThemeFontFace[] => {
	if (typeof value === "string") {
		return value.trim() === "" ? [] : [{ url: value.trim() }];
	}
	if (typeof value !== "object" || value === null) return [];
	return Array.isArray(value.faces) ? value.faces : [];
};

/**
 * `@font-face` rules for self-hosted delivery. Phase 4 fills
 * `fonts.assets` (family → URL string, or a {@link ThemeFontAsset}
 * with per-weight faces + metric-matched fallback) via the async asset
 * pipeline; bare strings keep the Phase-3 single-face shape. Until
 * files exist this returns "" and the shell emits nothing — graceful
 * by construction.
 */
export const fontFaceCss = (fonts: ThemeFontConfig | null): string => {
	if (fonts === null || fonts.delivery !== "self-host") return "";
	const assets = fonts.assets ?? {};
	const rules: string[] = [];
	for (const [family, value] of Object.entries(assets)) {
		const fam = escapeCssString(family);
		for (const face of assetFaces(value)) {
			if (typeof face.url !== "string" || face.url.trim() === "") continue;
			const url = face.url.trim();
			const format = face.format ?? FONT_FORMATS[extOfUrl(url)] ?? "woff2";
			const weight =
				typeof face.weight === "number" && Number.isInteger(face.weight)
					? `;font-weight:${face.weight}`
					: "";
			rules.push(
				`@font-face{font-family:"${fam}";src:url("${url}") format("${format}");font-display:swap${weight};}`,
			);
		}
		// Metric-matched local() fallback — emitted once per family,
		// after its webfont faces (font-family stack order does the rest).
		if (typeof value === "object" && value !== null) {
			const fb = value.fallback;
			if (fb != null && typeof fb.local === "string" && fb.local.trim() !== "") {
				const m = fb.metrics;
				rules.push(
					`@font-face{font-family:"${escapeCssString(fb.name)}";src:${localSrc(fb.local.trim())};` +
						`size-adjust:${m.sizeAdjust}%;ascent-override:${m.ascentOverride}%;` +
						`descent-override:${m.descentOverride}%;line-gap-override:${m.lineGapOverride}%;}`,
				);
			}
		}
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
