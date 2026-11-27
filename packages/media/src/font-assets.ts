import { Schema } from "effect";

/**
 * The catalog-font `theme_assets.variants` contract — the single
 * source of truth for the JSON the theme plugin WRITES
 * (`insertCatalogFontAsset`, uploads via /api/theme/catalog-fonts)
 * and the fonts plugin READS (`local` provider adapter →
 * `font_families` catalog) plus the theme managed-font cascade
 * (`variants.fontAsset` → self-host @font-face manifest).
 *
 * Before this module the contract was hand-rolled on both sides and
 * had already drifted: the writer stamped `weights`/`variable`/
 * `weightAxis`/`axes`/`unicodeRange`/`subsetKeys`/`fontAsset` while
 * the reader re-implemented each field's validation independently
 * (and still reads the legacy singular `subsetKey`). Writers and
 * readers now share the types + schemas below and the tolerant
 * normalizers — stored JSON is untrusted, so readers validate
 * field-by-field (malformed entries drop, they never fail the whole
 * row) while the schemas pin the canonical shape for writers/tests.
 *
 * Plain TS + effect/Schema only — no db/drizzle imports — so both
 * plugins and client-safe type re-exports can consume it.
 */

// ---------- canonical shapes ----------

/** One non-`wght` OpenType `fvar` variation axis — `wdth`, `opsz`,
 * `slnt`, `ital` or a custom 4-byte tag, values in axis units.
 * `wght` never appears here: {@link CatalogFontVariants.weightAxis}
 * owns it. */
// Type alias (not interface) so the object shape carries an implicit
// index signature and stays assignable to effect's `Json` meta type.
export type FontAxis = {
	readonly tag: string;
	readonly min: number;
	readonly default: number;
	readonly max: number;
};

export const FontAxisSchema = Schema.Struct({
	tag: Schema.String,
	min: Schema.Number,
	default: Schema.Number,
	max: Schema.Number,
});

/** `fvar` `wght` axis bounds in CSS font-weight units. */
export type FontAxisRange = {
	readonly min: number;
	readonly default: number;
	readonly max: number;
};

export const FontAxisRangeSchema = Schema.Struct({
	min: Schema.Number,
	default: Schema.Number,
	max: Schema.Number,
});

/** One `@font-face` src entry inside a font asset manifest. */
export interface FontFace {
	/** Serving URL (same-origin asset route). */
	readonly url: string;
	/** CSS font-weight; absent = 400. */
	readonly weight?: number;
	/** CSS font-weight RANGE (`[min, max]`) for variable fonts —
	 * emits `font-weight:min max` and takes precedence over `weight`. */
	readonly weightRange?: readonly [number, number];
	/** `unicode-range` descriptor ("U+0020-007E, …") — browsers skip
	 * downloading the face for scripts it cannot render. */
	readonly unicodeRange?: string;
	/** Non-`wght` `fvar` axes of a variable font. */
	readonly axes?: readonly FontAxis[];
	/** `format()` descriptor hint — "woff2" | "woff" | "truetype" | "opentype". */
	readonly format?: string;
}

export const FontFaceSchema = Schema.Struct({
	url: Schema.String,
	weight: Schema.optional(Schema.Number),
	weightRange: Schema.optional(Schema.Tuple([Schema.Number, Schema.Number])),
	unicodeRange: Schema.optional(Schema.String),
	axes: Schema.optional(Schema.Array(FontAxisSchema)),
	format: Schema.optional(Schema.String),
});

/** Metric-matched fallback overrides (fontaine/capsize algorithm) —
 * percentages emitted as `size-adjust`/`*-override` on the fallback
 * `@font-face`. */
export interface FontFallbackMetrics {
	readonly sizeAdjust: number;
	readonly ascentOverride: number;
	readonly descentOverride: number;
	readonly lineGapOverride: number;
}

export const FontFallbackMetricsSchema = Schema.Struct({
	sizeAdjust: Schema.Number,
	ascentOverride: Schema.Number,
	descentOverride: Schema.Number,
	lineGapOverride: Schema.Number,
});

export interface FontAssetFallback {
	/** Fallback family name — "<family> fallback" convention. */
	readonly name: string;
	/** System font the `local()` src resolves (e.g. "Arial"). */
	readonly local: string;
	readonly metrics: FontFallbackMetrics;
}

export const FontAssetFallbackSchema = Schema.Struct({
	name: Schema.String,
	local: Schema.String,
	metrics: FontFallbackMetricsSchema,
});

/** Self-hosted font manifest — the `variants.fontAsset` payload the
 * managed-font cascade serves for catalog fonts (`theme_id` NULL). */
export interface FontAssetManifest {
	readonly faces: readonly FontFace[];
	readonly fallback?: FontAssetFallback | null;
}

export const FontAssetManifestSchema = Schema.Struct({
	faces: Schema.Array(FontFaceSchema),
	fallback: Schema.optional(Schema.NullOr(FontAssetFallbackSchema)),
});

/**
 * The `theme_assets.variants` JSON of a fonts-catalog row
 * (`theme_id` NULL, kind "font"). Every field is optional because
 * legacy/partial rows exist — the tolerant helpers below decide which
 * fields a reader requires. `subsetKey` (singular) is the
 * pre-multi-subset legacy spelling: readable for cleanup, never
 * written.
 */
export interface CatalogFontVariants {
	/** Family name — required by every reader; rows without it are not
	 * catalog fonts (e.g. theme-owned font jobs' outcome payloads). */
	readonly family?: string;
	/** CSS font-weight list mirrored from the @font-face rules AND
	 * stamped here so the catalog sync can populate
	 * `font_families.weights` (absent/empty = 400 downstream). */
	readonly weights?: readonly number[];
	/** True when the font is variable (weightAxis and/or axes present). */
	readonly variable?: boolean;
	/** `fvar` wght axis bounds — one ranged @font-face replaces the
	 * discrete weight list. */
	readonly weightAxis?: FontAxisRange;
	/** Non-`wght` `fvar` axes (wdth/opsz/slnt/ital/custom). */
	readonly axes?: readonly FontAxis[];
	/** cmap-derived `unicode-range` download hint. */
	readonly unicodeRange?: string;
	/** R2 keys of the charset-subset siblings — supersede cleanup. */
	readonly subsetKeys?: readonly string[];
	/** Legacy singular subset key (latin-only era) — read-only. */
	readonly subsetKey?: string;
	/** Self-host @font-face manifest for the managed-font cascade. */
	readonly fontAsset?: FontAssetManifest;
}

export const CatalogFontVariantsSchema = Schema.Struct({
	family: Schema.optional(Schema.String),
	weights: Schema.optional(Schema.Array(Schema.Number)),
	variable: Schema.optional(Schema.Boolean),
	weightAxis: Schema.optional(FontAxisRangeSchema),
	axes: Schema.optional(Schema.Array(FontAxisSchema)),
	unicodeRange: Schema.optional(Schema.String),
	subsetKeys: Schema.optional(Schema.Array(Schema.String)),
	subsetKey: Schema.optional(Schema.String),
	fontAsset: Schema.optional(FontAssetManifestSchema),
});

// ---------- tolerant readers (stored JSON is untrusted) ----------

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

/** Registered fvar axis tags are 4 printable-ASCII bytes. */
const FONT_AXIS_TAG = /^[\x20-\x7E]{4}$/;

/** Same bound the theme plugin applies when stamping variants. */
export const MAX_FONT_AXES = 32;

/**
 * Validate an untrusted axis list (`fvar`-shaped `{tag,min,default,
 * max}` records — parser output on write, stored `variants.axes` /
 * `faces[].axes` on read) into {@link FontAxis}s: well-formed tag,
 * finite `min ≤ default ≤ max`, `wght` dropped (weightAxis owns it),
 * first record per tag wins, capped at {@link MAX_FONT_AXES}.
 * Returns [] for non-arrays — the single axis validator shared by the
 * theme writer (`insertCatalogFontAsset`), the fonts catalog reader
 * and any future producer.
 */
export const normalizeFontAxes = (input: unknown): FontAxis[] => {
	if (!Array.isArray(input)) return [];
	const seen = new Set<string>();
	const out: FontAxis[] = [];
	for (const item of input) {
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
	return out;
};

/** Tolerant `weightAxis`/`{min,default,max}` read — undefined on
 * absent or malformed payloads. */
export const fontAxisRangeOf = (value: unknown): FontAxisRange | undefined => {
	const axis = asRecord(value);
	if (axis === null) return undefined;
	const { min, default: def, max } = axis;
	if (
		typeof min !== "number" ||
		typeof def !== "number" ||
		typeof max !== "number" ||
		!Number.isFinite(min) ||
		!Number.isFinite(def) ||
		!Number.isFinite(max) ||
		!(min <= def && def <= max)
	) {
		return undefined;
	}
	return { min, default: def, max };
};

/** Tolerant `weights` read — sorted deduped integers, undefined when
 * absent/empty. */
export const fontWeightListOf = (value: unknown): number[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const weights = [
		...new Set(value.filter((w): w is number => typeof w === "number" && Number.isInteger(w))),
	].sort((a, b) => a - b);
	return weights.length === 0 ? undefined : weights;
};

/** Tolerant `unicodeRange` read — trimmed non-empty string. */
export const fontUnicodeRangeOf = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** Tolerant single-face read — a face without a string `url` is
 * dropped (it could only emit a broken @font-face). */
const fontFaceOf = (value: unknown): FontFace | null => {
	const face = asRecord(value);
	if (face === null) return null;
	const url = face["url"];
	if (typeof url !== "string" || url === "") return null;
	const weight = face["weight"];
	const weightRange = face["weightRange"];
	const axes = normalizeFontAxes(face["axes"]);
	const unicodeRange = fontUnicodeRangeOf(face["unicodeRange"]);
	const format = face["format"];
	const range = Array.isArray(weightRange) ? weightRange : null;
	const w0 = range?.[0];
	const w1 = range?.[1];
	return {
		url,
		...(typeof weight === "number" && Number.isFinite(weight) ? { weight } : {}),
		...(range !== null &&
		range.length === 2 &&
		typeof w0 === "number" &&
		Number.isFinite(w0) &&
		typeof w1 === "number" &&
		Number.isFinite(w1)
			? { weightRange: [w0, w1] as const }
			: {}),
		...(unicodeRange === undefined ? {} : { unicodeRange }),
		...(axes.length === 0 ? {} : { axes }),
		...(typeof format === "string" && format !== "" ? { format } : {}),
	};
};

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

/** Tolerant `fontAsset` manifest read — null unless `faces` is an
 * array; individual faces normalize field-by-field and the fallback
 * only survives with a complete metrics record. */
const fontAssetManifestOf = (value: unknown): FontAssetManifest | null => {
	const manifest = asRecord(value);
	if (manifest === null) return null;
	const facesRaw = manifest["faces"];
	if (!Array.isArray(facesRaw)) return null;
	const faces = facesRaw.map(fontFaceOf).filter((face): face is FontFace => face !== null);
	const fallbackRecord = asRecord(manifest["fallback"]);
	const metrics = asRecord(fallbackRecord?.["metrics"]);
	const fallback =
		fallbackRecord !== null &&
		typeof fallbackRecord["name"] === "string" &&
		typeof fallbackRecord["local"] === "string" &&
		metrics !== null &&
		isFiniteNumber(metrics["sizeAdjust"]) &&
		isFiniteNumber(metrics["ascentOverride"]) &&
		isFiniteNumber(metrics["descentOverride"]) &&
		isFiniteNumber(metrics["lineGapOverride"])
			? {
					name: fallbackRecord["name"] as string,
					local: fallbackRecord["local"] as string,
					metrics: {
						sizeAdjust: metrics["sizeAdjust"],
						ascentOverride: metrics["ascentOverride"],
						descentOverride: metrics["descentOverride"],
						lineGapOverride: metrics["lineGapOverride"],
					},
				}
			: null;
	return { faces, fallback };
};

/** Family name stamped on a catalog font asset's variants JSON —
 * trimmed, null on absent/malformed payloads. */
export const catalogFontFamilyOf = (variantsJson: string | null): string | null => {
	const variants = asRecord(parseJson(variantsJson));
	const family = variants?.["family"];
	return typeof family === "string" && family.trim() !== "" ? family.trim() : null;
};

/** R2 keys of the charset-subset siblings recorded as
 * `variants.subsetKeys` — plus the legacy singular `subsetKey`
 * (latin-only era) so older rows still clean up. [] when absent. */
export const catalogFontSubsetKeysOf = (variantsJson: string | null): string[] => {
	const variants = asRecord(parseJson(variantsJson));
	if (variants === null) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (key: unknown): void => {
		if (typeof key === "string" && key !== "" && !seen.has(key)) {
			seen.add(key);
			out.push(key);
		}
	};
	const list = variants["subsetKeys"];
	if (Array.isArray(list)) {
		for (const key of list) push(key);
	}
	push(variants["subsetKey"]);
	return out;
};

/** Self-host manifest stored under `variants.fontAsset` — the
 * {@link FontAssetManifest} the managed-font cascade serves for
 * `meta.assetId` lookups whose theme_assets row has no owning theme.
 * Null on absent/malformed payloads. */
export const catalogFontAssetOf = (variantsJson: string | null): FontAssetManifest | null => {
	const variants = asRecord(parseJson(variantsJson));
	return fontAssetManifestOf(variants?.["fontAsset"]);
};

/** Catalog-row variation info resolved for the fonts provider
 * adapter: family (required), CSS weights, variable-font markers and
 * the unicode-range hint. Pre-`weights` rows fall back to collecting
 * per-face `weight` descriptors, so older single-weight uploads still
 * report their weight to the catalog. */
export const catalogFontInfoOf = (
	variantsJson: string | null,
): {
	family: string;
	weights?: number[];
	variable?: boolean;
	weightAxis?: FontAxisRange;
	axes?: FontAxis[];
	unicodeRange?: string;
} | null => {
	const variants = asRecord(parseJson(variantsJson));
	const family = variants?.["family"];
	if (variants === null || typeof family !== "string" || family.trim() === "") return null;
	const weightAxis = fontAxisRangeOf(variants["weightAxis"]);
	const axes = normalizeFontAxes(variants["axes"]);
	const unicodeRange = fontUnicodeRangeOf(variants["unicodeRange"]);
	const variable = variants["variable"] === true || weightAxis !== undefined || axes.length > 0;
	const explicit = fontWeightListOf(variants["weights"]);
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
		...(axes.length === 0 ? {} : { axes }),
		...(unicodeRange === undefined ? {} : { unicodeRange }),
	};
};

/** Pre-`weights` rows: collect per-face `weight` descriptors. */
const faceWeightsOf = (variants: Record<string, unknown>): number[] | undefined => {
	const fontAsset = asRecord(variants["fontAsset"]);
	const faces = fontAsset?.["faces"];
	return Array.isArray(faces)
		? fontWeightListOf(faces.map((face) => asRecord(face)?.["weight"]))
		: undefined;
};
