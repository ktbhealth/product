/**
 * Row → wire presentation (P-082): turns a `theme_definitions` row
 * into the serializable `ResolvedTheme` shells consume — derived
 * tokens, the `:root`/`.dark` style block, font delivery links and
 * `@font-face` rules. Pure and client-safe (palette math only), so
 * the admin UI reuses it for live preview.
 */

import { googleFontCssHref } from "@ktb/fonts/adapters/googlefonts";

import { deriveThemeTokens, themeRadius, tokensToCss } from "./palette.ts";
import type {
	ResolvedTheme,
	ThemeBrand,
	ThemeFontAsset,
	ThemeFontAssetValue,
	ThemeFontAxis,
	ThemeFontConfig,
	ThemeFontFace,
	ThemeFontSlot,
	ThemeManagedFont,
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

/** Parse the `theme_definitions.fonts` JSON column; malformed or
 * non-object payloads degrade to null (same tolerance as seeds/brand). */
export const parseThemeFontConfig = (raw: string | null): ThemeFontConfig | null =>
	asConfigObject(parseJson<ThemeFontConfig | null>(raw, null));

/** Parse the `theme_definitions.brand` JSON column; malformed or
 * non-object payloads degrade to null. */
export const parseThemeBrand = (raw: string | null): ThemeBrand | null =>
	asConfigObject(parseJson<ThemeBrand | null>(raw, null));

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
 * family with the configured weights (default 400;500;600;700), in
 * slot order (sans → heading → mono). Managed-cascade families are
 * merged separately by {@link presentTheme}. */
export const googleFontLinks = (fonts: ThemeFontConfig | null): readonly string[] => {
	if (fonts === null || fonts.delivery !== "google-fonts") return [];
	const families = fonts.families ?? {};
	const names = [
		...new Set(
			[families.sans, families.heading, families.mono]
				.filter((f): f is string => typeof f === "string" && f.trim() !== "")
				.map((f) => f.trim()),
		),
	];
	const weights = (fonts.weights ?? [400, 500, 600, 700])
		.filter((w) => Number.isInteger(w) && w >= 100 && w <= 900)
		.sort((a, b) => a - b)
		.join(";");
	return names.map((name) => googleFontHref(name, weights));
};

/** css2 stylesheet href for a family + precomputed `wght@` list —
 * shared by {@link googleFontLinks} and the managed-cascade merge in
 * {@link presentTheme}. Space encoding matches googleFontCssHref
 * (encode first, then %20 → +) so multi-word families resolve. */
const googleFontHref = (name: string, weights: string): string =>
	`https://fonts.googleapis.com/css2?family=${encodeURIComponent(name.trim()).replaceAll("%20", "+")}:wght@${weights}&display=swap`;

const FONT_FORMATS: Readonly<Record<string, string>> = {
	woff2: "woff2",
	woff: "woff",
	ttf: "truetype",
	otf: "opentype",
};

const extOfUrl = (url: string): string => {
	const clean = url.split("#")[0]!;
	// split() always yields at least one element — pop() is never undefined.
	/* v8 ignore next -- pop() on split() is never undefined */
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

/**
 * Sanity-check one axis endpoint for CSS emission: a positive,
 * reasonably bounded percentage/number rendered with at most 4
 * decimals (the fvar parser's own precision — keeps `String(n)` out
 * of exponent notation). Returns null for anything unfit.
 */
const cssAxisNumber = (value: unknown): string | null => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10000) {
		return null;
	}
	const rounded = Math.round(value * 10000) / 10000;
	return rounded > 0 ? String(rounded) : null;
};

/**
 * `font-stretch` descriptor from a face's `axes` metadata. `wdth`
 * axis values ARE percentages, and the descriptor accepts
 * `<percentage>{1,2}` — two ascending values declare the variable
 * range, a single value pins the face. It is the ONLY non-wght axis
 * with an `@font-face` descriptor: `opsz`/`slnt`/`ital`/custom axes
 * apply via `font-variation-settings` on the element and are
 * deliberately never emitted here (single values only — a range
 * would be invalid CSS). Stored axes are untrusted JSON, so every
 * field is revalidated.
 */
const fontStretchDescriptor = (axes: ThemeFontFace["axes"]): string => {
	if (!Array.isArray(axes)) return "";
	for (const axis of axes) {
		if (typeof axis !== "object" || axis === null) continue;
		const candidate = axis as { tag?: unknown; min?: unknown; max?: unknown };
		if (candidate.tag !== "wdth") continue;
		const min = cssAxisNumber(candidate.min);
		const max = cssAxisNumber(candidate.max);
		if (min === null || max === null) return "";
		const lo = Number(min);
		const hi = Number(max);
		if (lo > hi) return "";
		return lo === hi ? `;font-stretch:${min}%` : `;font-stretch:${min}% ${max}%`;
	}
	return "";
};

/** Registered fvar axis tags are 4 alphanumeric chars; anything else
 * is dropped rather than risk emitting an invalid `font-variation-settings`
 * <string> (stored axes are untrusted JSON). */
const FONT_AXIS_TAG = /^[A-Za-z0-9]{4}$/;

/**
 * Axes owned by other CSS font mechanisms — never pinned through
 * `font-variation-settings`:
 * - `wght` → the `font-weight` descriptor/range on `@font-face`
 * - `wdth` → the `font-stretch` descriptor on `@font-face`
 * - `opsz` → `font-optical-sizing: auto` (the default) already applies
 *   it per element; pinning the fvar default would DISABLE that auto
 *   behavior
 * - `ital` → `font-style` matching drives it; pinning the fvar default
 *   would break `font-style: italic` (and `normal`) on the family
 */
const FVS_OWNED_TAGS: ReadonlySet<string> = new Set(["wght", "wdth", "opsz", "ital"]);

/**
 * Serialize one axis value for `font-variation-settings` — the fvar
 * parser's 4-decimal precision, exponent-free (CSS <number> has no
 * exponent notation). Values beyond ±1e6 are treated as corrupt.
 */
const fvsNumber = (value: number): string | null => {
	// Values beyond ±1e6 are treated as corrupt; the 4-decimal round
	// (the fvar parser's own precision) keeps String() out of exponent
	// notation, which CSS <number> rejects. -0 serializes as "0".
	if (Math.abs(value) > 1e6) return null;
	return String(Math.round(value * 10000) / 10000);
};

/**
 * `font-variation-settings` value (`'slnt' -5, 'XOPQ' 88`) for one
 * font's axis list. Policy: every remaining axis (`slnt` + custom
 * tags) is pinned at its fvar DEFAULT so the font renders at its
 * designed default rather than trusting whatever the browser would
 * pick. Degenerate axes (`min === max` — cannot vary), unowned-tag
 * axes, malformed entries and duplicate tags (first wins) are
 * skipped; an empty result means "emit nothing".
 */
const variationSettingsValue = (axes: readonly ThemeFontAxis[]): string => {
	// Callers pass a flattened, array-checked axis list (untrusted
	// stored JSON is revalidated entry-by-entry below).
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const axis of axes) {
		if (typeof axis !== "object" || axis === null) continue;
		const candidate = axis as {
			tag?: unknown;
			min?: unknown;
			default?: unknown;
			max?: unknown;
		};
		const tag = candidate.tag;
		if (
			typeof tag !== "string" ||
			!FONT_AXIS_TAG.test(tag) ||
			FVS_OWNED_TAGS.has(tag) ||
			seen.has(tag)
		) {
			continue;
		}
		const { min, default: def, max } = candidate;
		if (
			typeof min !== "number" ||
			typeof def !== "number" ||
			typeof max !== "number" ||
			!Number.isFinite(min) ||
			!Number.isFinite(def) ||
			!Number.isFinite(max) ||
			!(min <= def && def <= max) ||
			min === max
		) {
			continue;
		}
		const value = fvsNumber(def);
		if (value === null) continue;
		seen.add(tag);
		parts.push(`'${tag}' ${value}`);
	}
	return parts.join(", ");
};

/** `font-variation-settings` value for a family name — merges the
 * axes stamped on every face of its self-host asset (subset pairs
 * carry identical axes; duplicate tags collapse first-wins inside
 * {@link variationSettingsValue}). Bare-string assets and families
 * without stored faces yield "". */
const familyVariationSettings = (fonts: ThemeFontConfig, family: string): string => {
	const value = fonts.assets?.[family];
	if (value === undefined) return "";
	const axes = assetFaces(value).flatMap((face) => (Array.isArray(face.axes) ? face.axes : []));
	return variationSettingsValue(axes);
};

/** Selectors each font slot's family stack applies to — the base
 * layer in `@ktbhealth/ui` globals.css (`html`/`body`/`h1`–`h6`/
 * `code,pre`) plus the `font-*` utilities Tailwind generates from the
 * `--font-*` theme keys (`font-sans`/`font-body`/`font-geist` for
 * sans, `font-heading`, `font-mono`/`font-geist-mono`). The emitted
 * rules are unlayered so they win over the layered base/utility
 * declarations; `font-variation-settings` inherits, so covering
 * these sites covers every default application. */
const FONT_SLOT_VS_SELECTORS: Record<ThemeFontSlot, string> = {
	sans: "html,body,.font-sans,.font-body,.font-geist",
	heading: "h1,h2,h3,h4,h5,h6,.font-heading",
	mono: "code,pre,.font-mono,.font-geist-mono",
};

/**
 * `font-variation-settings` rules for a font config — one rule per
 * slot whose effective family carries non-degenerate axes. `heading`
 * falls back to the sans family exactly like {@link fontCssVars}.
 * Emitted only for self-host assets: google-fonts delivery has no
 * per-face axis metadata, and `font-variation-settings` on an element
 * using a static font is noise.
 */
export const fontVariationCss = (fonts: ThemeFontConfig | null): string => {
	if (fonts === null) return "";
	const families = fonts.families ?? {};
	const rules: string[] = [];
	for (const slot of FONT_SLOTS) {
		const family = slot === "heading" ? (families.heading ?? families.sans) : families[slot];
		if (typeof family !== "string" || family.trim() === "") continue;
		const settings = familyVariationSettings(fonts, family.trim());
		if (settings === "") continue;
		rules.push(`${FONT_SLOT_VS_SELECTORS[slot]}{font-variation-settings:${settings};}`);
	}
	return rules.join("\n");
};

/** `font-variation-settings` value for one slot — the same resolution
 * {@link fontVariationCss} applies, exposed for live previews
 * (editor specimens style elements inline, outside the emitted
 * rules). */
export const fontVariationSettingsForSlot = (
	fonts: ThemeFontConfig | null,
	slot: ThemeFontSlot,
): string => {
	if (fonts === null) return "";
	const families = fonts.families ?? {};
	const family = slot === "heading" ? (families.heading ?? families.sans) : families[slot];
	if (typeof family !== "string" || family.trim() === "") return "";
	return familyVariationSettings(fonts, family.trim());
};

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
			// Variable fonts carry a weight RANGE (`font-weight:min max`);
			// it wins over the discrete `weight` descriptor.
			const range = face.weightRange;
			const weight =
				Array.isArray(range) &&
				range.length === 2 &&
				typeof range[0] === "number" &&
				typeof range[1] === "number" &&
				Number.isFinite(range[0]) &&
				Number.isFinite(range[1]) &&
				range[0] <= range[1]
					? `;font-weight:${range[0]} ${range[1]}`
					: typeof face.weight === "number" && Number.isInteger(face.weight)
						? `;font-weight:${face.weight}`
						: "";
			// unicode-range comes from our own cmap parser but the value
			// rides stored JSON — allowlist the descriptor alphabet so a
			// hand-edited row cannot inject CSS.
			const unicodeRange =
				typeof face.unicodeRange === "string" &&
				face.unicodeRange
					.split(",")
					.every((part) => /^U\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f?]{1,6})?$/.test(part.trim()))
					? `;unicode-range:${face.unicodeRange}`
					: "";
			const fontStretch = fontStretchDescriptor(face.axes);
			rules.push(
				`@font-face{font-family:"${fam}";src:url("${url}") format("${format}");font-display:swap${weight}${fontStretch}${unicodeRange};}`,
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

const FONT_SLOTS: readonly ThemeFontSlot[] = ["sans", "heading", "mono"];

/** Default weight list for managed googlefonts links when neither the
 * catalog row nor the theme configures weights (mirrors
 * {@link googleFontLinks}' fallback). */
const MANAGED_DEFAULT_WEIGHTS = [400, 500, 600, 700] as const;

/**
 * The complete `:root`/`.dark` override block for a resolved theme:
 * derived tokens + radius + font vars (scheme-independent, `:root`
 * only) plus the per-slot `font-variation-settings` element rules
 * non-wght/non-wdth font axes need. Stored `tokens` JSON on the row
 * is ignored — seeds are the source of truth so the palette engine
 * can never drift from stored output.
 */
export const themeStyleCss = (theme: {
	readonly seeds: ThemeSeeds;
	readonly fonts: ThemeFontConfig | null;
}): string => {
	const base = tokensToCss(deriveThemeTokens(theme.seeds), {
		"--radius": themeRadius(theme.seeds),
		...fontCssVars(theme.fonts),
	});
	// Per-slot font-variation-settings rules ride the same style block —
	// they are element rules, not custom properties, so they append
	// after the :root/.dark token blocks.
	const variation = fontVariationCss(theme.fonts);
	return variation === "" ? base : `${base}\n${variation}`;
};

/**
 * Present a `theme_definitions` row as a `ResolvedTheme`. Invalid JSON
 * columns degrade to empty config rather than failing the request —
 * a malformed row must never take down a shell.
 *
 * `options.managed` carries fonts-catalog resolutions (see
 * managed-fonts.ts): each entry pins a `fonts.sources.<slot>`
 * reference to a synced provider family. Resolved managed families
 * override the slot's free-form name in the font vars, deliver
 * googlefonts kinds as stylesheet links with catalog weights and
 * self-host kinds as `@font-face` rules — independent of the theme's
 * `delivery` field, which keeps governing the unmanaged families.
 */
export const presentTheme = (
	row: ThemeDefinitionRow,
	options?: { readonly preview?: boolean; readonly managed?: readonly ThemeManagedFont[] },
): ResolvedTheme => {
	const seeds = asConfigObject(parseJson<ThemeSeeds | null>(row.seeds, null)) ?? {};
	const fonts = parseThemeFontConfig(row.fonts);
	const brand = parseThemeBrand(row.brand);
	const managed = options?.managed ?? [];

	// Slot → managed family name, plus the delivery payloads each
	// resolved source contributes. Matching is by (providerId, family)
	// against `fonts.sources` — entries for unreferenced providers are
	// ignored.
	const slotNames = new Map<ThemeFontSlot, string>();
	const managedGoogleBySlot = new Map<
		ThemeFontSlot,
		{ family: string; weights: readonly number[] }
	>();
	const managedGoogleFamilies = new Set<string>();
	const managedAssets = new Map<string, ThemeFontAsset>();
	if (fonts?.sources !== undefined && managed.length > 0) {
		const byRef = new Map(managed.map((m) => [`${m.providerId} ${m.family}`, m]));
		for (const slot of FONT_SLOTS) {
			const source = fonts.sources[slot];
			if (source === null || source === undefined) continue;
			const m = byRef.get(`${source.providerId} ${source.family.trim()}`);
			if (m === undefined) continue;
			slotNames.set(slot, m.family);
			if (m.kind === "googlefonts") {
				managedGoogleFamilies.add(m.family);
				managedGoogleBySlot.set(slot, {
					family: m.family,
					weights: m.weights.length > 0 ? m.weights : MANAGED_DEFAULT_WEIGHTS,
				});
			} else if (m.asset != null) {
				managedAssets.set(m.family, m.asset);
			}
		}
	}

	// Effective config for the font vars: managed names win per slot
	// and managed assets join `assets` so the metric-matched fallback
	// face name lands in the family stack. `fonts` itself stays the
	// stored config — ResolvedTheme.fonts must round-trip through the
	// editor unchanged.
	const effectiveFonts: ThemeFontConfig | null =
		fonts === null
			? null
			: {
					...fonts,
					families: { ...(fonts.families ?? {}), ...Object.fromEntries(slotNames) },
					assets: { ...(fonts.assets ?? {}), ...Object.fromEntries(managedAssets) },
				};

	// Slot-priority merge (sans → heading → mono): a managed
	// googlefonts source emits its catalog-weight link for its slot
	// first; the slot's free-form family follows when delivery opts
	// into google-fonts and the name isn't claimed by a managed
	// source (managedGoogleFamilies — managed wins same-family
	// duplicates). Dedupe is by family, first occurrence wins; with
	// no managed sources this reduces to googleFontLinks' order.
	const fontLinks: string[] = [];
	const linkedFamilies = new Set<string>();
	const link = (family: string, href: string) => {
		const key = family.trim();
		if (key === "" || linkedFamilies.has(key)) return;
		linkedFamilies.add(key);
		fontLinks.push(href);
	};
	const freeWeightParam = (fonts?.weights ?? [400, 500, 600, 700])
		.filter((w) => Number.isInteger(w) && w >= 100 && w <= 900)
		.sort((a, b) => a - b)
		.join(";");
	const freeFamilies = fonts?.families ?? {};
	for (const slot of FONT_SLOTS) {
		const managedEntry = managedGoogleBySlot.get(slot);
		if (managedEntry !== undefined) {
			link(managedEntry.family, googleFontCssHref(managedEntry.family, managedEntry.weights));
		}
		if (fonts?.delivery === "google-fonts") {
			const name = freeFamilies[slot];
			if (typeof name === "string") {
				const trimmed = name.trim();
				if (trimmed !== "" && !managedGoogleFamilies.has(trimmed)) {
					link(trimmed, googleFontHref(trimmed, freeWeightParam));
				}
			}
		}
	}

	// Self-host faces: the stored config's assets minus families a
	// managed source now owns (the managed asset wins — it is the
	// pinned catalog source), then the managed assets themselves,
	// emitted regardless of `delivery`.
	const genericAssets =
		fonts?.assets === undefined
			? fonts?.assets
			: Object.fromEntries(
					Object.entries(fonts.assets).filter(([family]) => !managedAssets.has(family)),
				);
	const fontFaceCssOut = [
		fontFaceCss(fonts === null ? null : { ...fonts, assets: genericAssets }),
		fontFaceCss({ delivery: "self-host", assets: Object.fromEntries(managedAssets) }),
	]
		.filter((css) => css !== "")
		.join("\n");

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
		styleCss: themeStyleCss({ seeds, fonts: effectiveFonts }),
		fonts,
		fontLinks,
		fontFaceCss: fontFaceCssOut,
		brand,
		...(options?.preview === true ? { preview: true as const } : {}),
	};
};
