import * as Effect from "effect/Effect";
import { and, eq } from "drizzle-orm";

import { Db } from "@ktb/db";
import { themeAssets, themeDefinitions } from "@ktb/db/schema";

import type { FontCatalogEntry, FontProviderAdapter } from "../registry.ts";

/**
 * "local" adapter — families found in `theme_assets` rows with
 * kind="font" and status="ready" (the theme plugin's asset pipeline:
 * admin-uploaded font files and fetched Google Fonts both land here).
 *
 * Family names resolve in two steps: a `family` field on the asset's
 * `variants` JSON wins when present (future pipeline versions may
 * stamp it); otherwise the parent theme's `fonts` JSON is consulted —
 * `families` slot values plus `assets` keys are the configured family
 * names. Rows with neither are skipped.
 */

interface ThemeFontsJson {
	readonly families?: {
		readonly sans?: string | null;
		readonly heading?: string | null;
		readonly mono?: string | null;
	};
	readonly weights?: readonly number[];
	readonly assets?: Record<string, unknown>;
}

const parseJson = (raw: string | null): unknown => {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

// Type alias (not interface) so the object shape carries an implicit
// index signature and stays assignable to effect's `Json` meta type.
type FontAxisMeta = {
	readonly tag: string;
	readonly min: number;
	readonly default: number;
	readonly max: number;
};

/** Theme-owned font rows have no variation metadata — only catalog
 * uploads (variantInfoOf) carry it. */
interface ResolvedFamilies {
	readonly families: string[];
	readonly weights?: number[];
	readonly variable?: boolean;
	readonly weightAxis?: { min: number; default: number; max: number };
	readonly axes?: FontAxisMeta[];
	readonly unicodeRange?: string;
}

const fontFamiliesOf = (fontsJson: string | null): ResolvedFamilies => {
	const fonts = asRecord(parseJson(fontsJson)) as ThemeFontsJson | null;
	if (fonts === null) return { families: [] };
	const names = new Set<string>();
	for (const slot of ["sans", "heading", "mono"] as const) {
		const family = fonts.families?.[slot];
		if (typeof family === "string" && family.trim() !== "") names.add(family.trim());
	}
	if (fonts.assets !== null && typeof fonts.assets === "object") {
		for (const family of Object.keys(fonts.assets)) {
			if (family.trim() !== "") names.add(family.trim());
		}
	}
	const weights = Array.isArray(fonts.weights)
		? fonts.weights.filter((w): w is number => typeof w === "number")
		: undefined;
	return { families: [...names], ...(weights === undefined ? {} : { weights }) };
};

const asWeightList = (value: unknown): number[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const weights = [
		...new Set(value.filter((w): w is number => typeof w === "number" && Number.isInteger(w))),
	].sort((a, b) => a - b);
	return weights.length === 0 ? undefined : weights;
};

const asWeightAxis = (
	value: unknown,
): { min: number; default: number; max: number } | undefined => {
	const axis = asRecord(value);
	if (axis === null) return undefined;
	const { min, default: def, max } = axis;
	if (
		typeof min !== "number" ||
		typeof def !== "number" ||
		typeof max !== "number" ||
		!(min <= def && def <= max)
	) {
		return undefined;
	}
	return { min, default: def, max };
};

const asUnicodeRange = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** Registered fvar axis tags are 4 printable-ASCII bytes. */
const FONT_AXIS_TAG = /^[\x20-\x7E]{4}$/;

/** Same bound the theme plugin applies when stamping variants. */
const MAX_FONT_AXES = 32;

/**
 * Non-`wght` `fvar` axes stamped on catalog variants by the theme
 * plugin's font pipeline — validated like {@link asWeightAxis}:
 * well-formed tag, finite min ≤ default ≤ max, first per tag, capped.
 * `wght` entries are dropped (weightAxis owns that axis).
 */
const asAxes = (value: unknown): FontAxisMeta[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const out: FontAxisMeta[] = [];
	for (const item of value) {
		if (out.length >= MAX_FONT_AXES) break;
		const axis = asRecord(item);
		if (axis === null) continue;
		const tag = axis["tag"];
		const min = axis["min"];
		const def = axis["default"];
		const max = axis["max"];
		if (
			typeof tag !== "string" ||
			!FONT_AXIS_TAG.test(tag) ||
			tag === "wght" ||
			seen.has(tag) ||
			typeof min !== "number" ||
			typeof def !== "number" ||
			typeof max !== "number" ||
			!Number.isFinite(min) ||
			!Number.isFinite(def) ||
			!Number.isFinite(max) ||
			!(min <= def && def <= max)
		) {
			continue;
		}
		seen.add(tag);
		out.push({ tag, min, default: def, max });
	}
	return out.length === 0 ? undefined : out;
};

/**
 * Catalog-upload rows (theme_assets.theme_id NULL) stamp `family` plus
 * an optional `weights` array — mirrored from the @font-face weights —
 * on their variants JSON. Variable-font uploads additionally stamp
 * `variable`/`weightAxis` (the fvar wght range), `axes` (the other
 * fvar axes — wdth/opsz/slnt/ital/custom) and `unicodeRange`
 * (cmap-derived); the axis reports `[min, max]` as the family's
 * weights and rides `meta` so consumers can distinguish a ranged face
 * from discrete weights. Rows written before weights existed fall
 * back to collecting the per-face `weight` descriptors, so older
 * single-weight uploads still report their weight to the catalog.
 */
const variantInfoOf = (
	variantsJson: string | null,
): {
	family: string;
	weights?: number[];
	variable?: boolean;
	weightAxis?: { min: number; default: number; max: number };
	axes?: FontAxisMeta[];
	unicodeRange?: string;
} | null => {
	const variants = asRecord(parseJson(variantsJson));
	const family = variants?.["family"];
	if (variants === null || typeof family !== "string" || family.trim() === "") return null;
	const weightAxis = asWeightAxis(variants["weightAxis"]);
	const axes = asAxes(variants["axes"]);
	const unicodeRange = asUnicodeRange(variants["unicodeRange"]);
	const variable = variants["variable"] === true || weightAxis !== undefined || axes !== undefined;
	const explicit = asWeightList(variants["weights"]);
	// A variable font's "weights" are its axis endpoints — more honest
	// than the discrete list (which is absent for pure variable uploads).
	const axisWeights =
		weightAxis === undefined ? undefined : [weightAxis.min, weightAxis.max].sort((a, b) => a - b);
	const weights = explicit ?? axisWeights ?? faceWeightsOf(variants);
	return {
		family: family.trim(),
		...(weights === undefined ? {} : { weights }),
		...(variable ? { variable: true } : {}),
		...(weightAxis === undefined ? {} : { weightAxis }),
		...(axes === undefined ? {} : { axes }),
		...(unicodeRange === undefined ? {} : { unicodeRange }),
	};
};

/** Pre-`weights` rows: collect per-face `weight` descriptors. */
const faceWeightsOf = (variants: Record<string, unknown>): number[] | undefined => {
	const fontAsset = asRecord(variants["fontAsset"]);
	const faces = fontAsset?.["faces"];
	return Array.isArray(faces)
		? asWeightList(faces.map((face) => asRecord(face)?.["weight"]))
		: undefined;
};

export const localFontProviderAdapter: FontProviderAdapter = {
	kind: "local",
	list: () =>
		Effect.gen(function* () {
			const db = yield* Db;
			const rows = yield* Effect.promise(() =>
				db
					.select({
						assetId: themeAssets.id,
						themeId: themeAssets.themeId,
						variants: themeAssets.variants,
						themeFonts: themeDefinitions.fonts,
					})
					.from(themeAssets)
					.leftJoin(themeDefinitions, eq(themeAssets.themeId, themeDefinitions.id))
					.where(and(eq(themeAssets.kind, "font"), eq(themeAssets.status, "ready"))),
			);

			// Dedupe by family — several assets can serve one family.
			const byFamily = new Map<string, FontCatalogEntry>();
			for (const row of rows) {
				const direct = variantInfoOf(row.variants);
				const resolved: ResolvedFamilies =
					direct !== null
						? {
								families: [direct.family],
								...(direct.weights === undefined ? {} : { weights: direct.weights }),
								...(direct.variable === true ? { variable: true } : {}),
								...(direct.weightAxis === undefined ? {} : { weightAxis: direct.weightAxis }),
								...(direct.axes === undefined ? {} : { axes: direct.axes }),
								...(direct.unicodeRange === undefined ? {} : { unicodeRange: direct.unicodeRange }),
							}
						: fontFamiliesOf(row.themeFonts);
				for (const family of resolved.families) {
					if (byFamily.has(family)) continue;
					byFamily.set(family, {
						family,
						...(resolved.weights === undefined ? {} : { weights: resolved.weights }),
						meta: {
							source: "local",
							assetId: row.assetId,
							...(resolved.variable === true ? { variable: true } : {}),
							...(resolved.weightAxis === undefined ? {} : { weightAxis: resolved.weightAxis }),
							...(resolved.axes === undefined ? {} : { axes: resolved.axes }),
							...(resolved.unicodeRange === undefined
								? {}
								: { unicodeRange: resolved.unicodeRange }),
						},
					});
				}
			}
			return [...byFamily.values()];
		}),
};
