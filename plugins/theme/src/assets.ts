/**
 * Theme asset pipeline domain (P-082/PL-006 phase 4): asset kinds,
 * image variant planning, job payload contracts, `theme_assets` /
 * `theme_definitions` repo helpers and Google Fonts CSS parsing.
 *
 * Transport stays at the edge per ADR-0001: the api-route stores bytes
 * in R2 and enqueues via the jobs port; the queue consumer (./jobs.ts)
 * decodes images with the WASM
 * processor, writes derivatives back to R2 and calls the repo helpers
 * here. Everything in this module is plain TS — no workerd/node APIs —
 * so it stays unit-testable.
 */

import { Schema } from "effect";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { themeAssets, themeDefinitions } from "@ktb/db/schema";

import type {
	ThemeAssetKind,
	ThemeBrand,
	ThemeFontAsset,
	ThemeFontAxis,
	ThemeFontConfig,
	ThemeFontFace,
	ThemeFontSlot,
} from "./types.ts";
import type { FontVariationAxis, FontWeightAxis } from "./font-variations.ts";

// ---------- kinds, keys, serving URLs ----------

/** Queue job kinds dispatched by the dedicated ktb-theme-assets queue. */
export const THEME_ASSET_JOB_KIND = "theme.asset";
export const THEME_FONT_JOB_KIND = "theme.font";

/** R2 key prefix — the serving route refuses anything outside it. */
export const THEME_ASSETS_PREFIX = "theme-assets/";

export const THEME_ASSET_KINDS = [
	"logo-light",
	"logo-dark",
	"wordmark",
	"favicon",
	"og-image",
	"font",
] as const satisfies readonly ThemeAssetKind[];

export const isThemeAssetKind = (value: string): value is ThemeAssetKind =>
	(THEME_ASSET_KINDS as readonly string[]).includes(value);

export const isImageAssetKind = (kind: ThemeAssetKind): boolean => kind !== "font";

/** Public serving URL for an R2 key — same-origin route, never a
 * signed/public bucket URL (bucket stays private). */
export const themeAssetUrl = (key: string): string =>
	`/api/theme/assets?key=${encodeURIComponent(key)}`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	webp: "image/webp",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	avif: "image/avif",
	woff2: "font/woff2",
	woff: "font/woff",
	ttf: "font/ttf",
	otf: "font/otf",
};

const FORMATS: Readonly<Record<string, string>> = {
	woff2: "woff2",
	woff: "woff",
	ttf: "truetype",
	otf: "opentype",
};

export const extOfKey = (key: string): string => {
	// split() always yields at least one element — pop() is never undefined.
	/* v8 ignore next -- pop() on split() is never undefined */
	const base = key.split("?")[0]!.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
};

export const contentTypeForKey = (key: string): string =>
	CONTENT_TYPES[extOfKey(key)] ?? "application/octet-stream";

/** `format()` descriptor hint for a font file key/extension. */
export const fontFormatForExt = (ext: string): string | undefined => FORMATS[ext];

/** Accepted upload extensions per asset class. */
export const IMAGE_UPLOAD_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
export const FONT_UPLOAD_EXTENSIONS = ["woff2", "woff", "ttf", "otf"] as const;

// ---------- catalog font weights ----------

const isCatalogWeight = (n: number): boolean => Number.isInteger(n) && n >= 100 && n <= 900;

/** Registered fvar axis tags are 4 printable-ASCII bytes. */
const FONT_AXIS_TAG = /^[\x20-\x7E]{4}$/;

/** Same bound as the fvar parser — keeps stored manifests small. */
const MAX_FONT_AXES = 32;

/**
 * Sanitize parser-supplied (or hand-edited) `fvar` axes for storage:
 * well-formed 4-char tag, finite min ≤ default ≤ max, first record
 * per tag wins, `wght` dropped (weightAxis owns it), capped at
 * {@link MAX_FONT_AXES}. Returns [] for absent/malformed input.
 */
const sanitizeFontAxes = (input: readonly FontVariationAxis[] | undefined): ThemeFontAxis[] => {
	if (!Array.isArray(input)) return [];
	const seen = new Set<string>();
	const out: ThemeFontAxis[] = [];
	for (const axis of input) {
		if (out.length >= MAX_FONT_AXES) break;
		if (typeof axis !== "object" || axis === null) continue;
		const { tag, min, default: def, max } = axis;
		if (typeof tag !== "string" || !FONT_AXIS_TAG.test(tag) || tag === "wght") continue;
		if (seen.has(tag)) continue;
		if (
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

/**
 * Parse a catalog-upload weight field into a sorted, deduped CSS
 * font-weight list. Accepts single values ("700"), comma/semicolon/
 * whitespace separated lists ("400,700", "400 700") and inclusive
 * ranges ("400-700" → 400;500;600;700 — ranges step by 100 so a
 * variable-font span stays a practical css2 `wght@` list). Returns
 * null on any malformed token, out-of-range value or descending
 * range — the route turns that into a 400.
 */
export const parseFontWeightList = (raw: string): readonly number[] | null => {
	const text = raw.trim();
	if (text === "") return null;
	const weights = new Set<number>();
	const token = /(\d{1,3})\s*(?:[-–—]\s*(\d{1,3}))?/y;
	let pos = 0;
	let saw = false;
	while (pos < text.length) {
		const sep = /^[\s,;]+/.exec(text.slice(pos));
		if (sep !== null) {
			pos += sep[0].length;
			continue;
		}
		token.lastIndex = pos;
		const match = token.exec(text);
		if (match === null) return null;
		pos = token.lastIndex;
		saw = true;
		const lo = Number(match[1]);
		const hi = match[2] === undefined ? lo : Number(match[2]);
		if (!isCatalogWeight(lo) || !isCatalogWeight(hi) || hi < lo) return null;
		if (match[2] === undefined) {
			weights.add(lo);
		} else {
			for (let w = lo; w <= hi; w += 100) weights.add(w);
		}
	}
	if (!saw) return null;
	return [...weights].sort((a, b) => a - b);
};

/** Style-word → CSS weight for filename hints (longest phrases
 * first so "semi bold"/"extra bold" win over "bold"). */
const FONT_WEIGHT_PHRASES: readonly (readonly [string, number])[] = [
	["extra light", 200],
	["ultra light", 200],
	["semi bold", 600],
	["demi bold", 600],
	["extra bold", 800],
	["ultra bold", 800],
	["extralight", 200],
	["ultralight", 200],
	["semibold", 600],
	["extrabold", 800],
	["ultrabold", 800],
	["thin", 100],
	["light", 300],
	["regular", 400],
	["normal", 400],
	["book", 400],
	["medium", 500],
	["bold", 700],
	["black", 900],
	["heavy", 900],
];

/**
 * Best-effort weight hint from an uploaded file name — "Inter-Bold",
 * "Inter_700", "roboto-medium.woff2". CamelCase and separator runs are
 * normalized to spaces first so "SemiBold" reads as "semi bold". A
 * standalone 3+-digit token in the 100–900 range wins over style
 * words; returns undefined when nothing plausible is found (variable
 * fonts like "Inter-VariableFont_wdth,wght" correctly yield nothing —
 * the admin should pass an explicit range for those).
 */
export const weightFromFileName = (fileName: string): number | undefined => {
	const dot = fileName.lastIndexOf(".");
	const stem = (dot === -1 ? fileName : fileName.slice(0, dot))
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	const tokens = stem
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t !== "");
	for (const token of tokens) {
		if (!/^\d+$/.test(token)) continue;
		const n = Number(token);
		if (isCatalogWeight(n)) return n;
	}
	const normalized = ` ${tokens.join(" ")} `;
	for (const [phrase, weight] of FONT_WEIGHT_PHRASES) {
		if (normalized.includes(` ${phrase} `)) return weight;
	}
	return undefined;
};

// ---------- image variant planning (pure) ----------

export interface VariantTemplate {
	/** File-name suffix under the asset's variant dir. */
	readonly name: string;
	/** Target width in px; height derives from aspect unless `square`. */
	readonly width: number;
	/** Force a centered square crop (favicons/app icons). */
	readonly square?: boolean;
	readonly formats: readonly ("png" | "webp")[];
}

const LOGO_PLAN: readonly VariantTemplate[] = [
	{ name: "logo-512", width: 512, formats: ["webp", "png"] },
	{ name: "logo-256", width: 256, formats: ["webp"] },
];

const IMAGE_VARIANT_PLANS: Readonly<
	Record<Exclude<ThemeAssetKind, "font">, readonly VariantTemplate[]>
> = {
	"logo-light": LOGO_PLAN,
	"logo-dark": LOGO_PLAN,
	wordmark: LOGO_PLAN,
	favicon: [
		{ name: "favicon-16", width: 16, square: true, formats: ["png"] },
		{ name: "favicon-32", width: 32, square: true, formats: ["png"] },
		{ name: "apple-touch-icon", width: 180, square: true, formats: ["png"] },
	],
	"og-image": [{ name: "og-image-1200", width: 1200, formats: ["webp", "png"] }],
};

export interface PlannedVariant {
	readonly name: string;
	readonly width: number;
	readonly height: number;
	readonly format: "png" | "webp";
	/** R2 key the consumer writes. */
	readonly key: string;
	/** True when the source must be center-cropped to a square first. */
	readonly square: boolean;
}

const clampDim = (n: number): number => Math.max(1, Math.round(n));

/**
 * Concrete variant list for one uploaded image: template × source
 * aspect → target box. `baseKey` is the original's R2 key; variants
 * live next to it as `<base>-<name>.<ext>`.
 */
export const planImageVariants = (
	kind: ThemeAssetKind,
	sourceWidth: number,
	sourceHeight: number,
	baseKey: string,
): readonly PlannedVariant[] => {
	if (kind === "font") return [];
	const dot = baseKey.lastIndexOf(".");
	const stem = dot === -1 ? baseKey : baseKey.slice(0, dot);
	const out: PlannedVariant[] = [];
	for (const template of IMAGE_VARIANT_PLANS[kind]) {
		for (const format of template.formats) {
			const square = template.square === true;
			const width = template.width;
			const height = square ? width : clampDim((sourceHeight / Math.max(1, sourceWidth)) * width);
			out.push({
				name: template.name,
				width,
				height,
				format,
				square,
				key: `${stem}-${template.name}.${format}`,
			});
		}
	}
	return out;
};

/** `theme_definitions.brand` field each image kind feeds on success. */
export const BRAND_FIELD_FOR_KIND = {
	"logo-light": "logoLight",
	"logo-dark": "logoDark",
	wordmark: "wordmark",
	favicon: "favicon",
	"og-image": "ogImage",
} as const satisfies Partial<Record<ThemeAssetKind, keyof ThemeBrand>>;

export type BrandAssetKind = keyof typeof BRAND_FIELD_FOR_KIND;

export const isBrandAssetKind = (kind: ThemeAssetKind): kind is BrandAssetKind => kind !== "font";

/** Canonical variant name the brand ref points at (webp preferred for
 * logos, png for favicon/og compatibility). */
export const primaryVariantName = (kind: BrandAssetKind): string => {
	switch (kind) {
		case "favicon":
			return "favicon-32.png";
		case "og-image":
			return "og-image-1200.png";
		default:
			return "logo-512.webp";
	}
};

// ---------- dominant color → seed suggestion ----------

/** "#rrggbb" from 8-bit channels; null channels → null. */
export const dominantColorHex = (r: number, g: number, b: number): string =>
	`#${[r, g, b]
		.map((c) =>
			Math.max(0, Math.min(255, Math.round(c)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;

/** Suggested `primary` seed from a dominant color — stored on the
 * asset row for the admin to apply; never auto-published. */
export const suggestedSeedsFromColor = (hex: string): { readonly primary: string } => ({
	primary: hex,
});

// ---------- job payload contracts ----------

/** Image asset job: the upload route already stored the original. */
export const ThemeAssetJobPayloadSchema = Schema.Struct({
	assetId: Schema.Number,
	themeId: Schema.Number,
	kind: Schema.String,
	key: Schema.String,
});
export type ThemeAssetJobPayload = typeof ThemeAssetJobPayloadSchema.Type;
export const decodeThemeAssetJob = Schema.decodeUnknownSync(ThemeAssetJobPayloadSchema);

/**
 * Font job — two sources:
 * - "upload": `key` holds the admin-uploaded font file (woff2/woff/ttf/otf).
 * - "google": the consumer downloads `family` at `weights` from Google
 *   Fonts (woff2) plus a TTF metrics probe; no upload needed.
 */
export const ThemeFontJobPayloadSchema = Schema.Union([
	Schema.Struct({
		assetId: Schema.Number,
		themeId: Schema.Number,
		family: Schema.String,
		slot: Schema.Literals(["sans", "heading", "mono"]),
		source: Schema.Literal("upload"),
		key: Schema.String,
		format: Schema.String,
	}),
	Schema.Struct({
		assetId: Schema.Number,
		themeId: Schema.Number,
		family: Schema.String,
		slot: Schema.Literals(["sans", "heading", "mono"]),
		source: Schema.Literal("google"),
		weights: Schema.Array(Schema.Number),
	}),
]);
export type ThemeFontJobPayload = typeof ThemeFontJobPayloadSchema.Type;
export const decodeThemeFontJob = Schema.decodeUnknownSync(ThemeFontJobPayloadSchema);

// ---------- repo helpers (plain async; authz lives in callers) ----------

export interface ThemeAssetRow {
	readonly id: number;
	readonly themeId: number | null;
	readonly kind: string;
	readonly r2Key: string | null;
	readonly status: string;
	readonly variants: string | null;
	readonly createdAt: Date;
}

export const insertThemeAsset = async (
	db: DbClient,
	input: { themeId: number | null; kind: ThemeAssetKind; r2Key: string | null },
): Promise<ThemeAssetRow | null> => {
	const rows = await db
		.insert(themeAssets)
		.values({
			themeId: input.themeId,
			kind: input.kind,
			r2Key: input.r2Key,
			status: "pending",
			createdAt: new Date(),
		})
		.returning();
	return (rows[0] as ThemeAssetRow | undefined) ?? null;
};

export const getThemeAsset = async (db: DbClient, id: number): Promise<ThemeAssetRow | null> => {
	const rows = await db.select().from(themeAssets).where(eq(themeAssets.id, id)).limit(1);
	return (rows[0] as ThemeAssetRow | undefined) ?? null;
};

/** Upload rows for one theme, newest first — the admin editor's asset tab. */
export const listThemeAssets = async (db: DbClient, themeId: number): Promise<ThemeAssetRow[]> =>
	db
		.select()
		.from(themeAssets)
		.where(eq(themeAssets.themeId, themeId))
		.orderBy(desc(themeAssets.createdAt), desc(themeAssets.id));

// ---------- fonts-catalog assets (themeId NULL) ----------
//
// Catalog font uploads (/api/theme/catalog-fonts) are NOT owned by a
// theme: the row keeps theme_id NULL and carries the family name plus
// the self-host {@link ThemeFontAsset} manifest inside `variants`
// (`family` + `fontAsset` keys — the fonts plugin's local adapter reads
// `family`, the theme managed-font cascade reads `fontAsset`). The
// file itself needs no processing, so the row lands directly as
// "ready" — no queue round-trip.

/** Family name stamped on a catalog font asset's variants JSON. */
export const catalogFontFamilyOf = (variantsJson: string | null): string | null => {
	if (variantsJson === null) return null;
	try {
		const parsed = JSON.parse(variantsJson) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const family = (parsed as Record<string, unknown>)["family"];
		return typeof family === "string" && family.trim() !== "" ? family.trim() : null;
	} catch {
		return null;
	}
};

/** R2 keys of the charset-subset siblings recorded as
 * `variants.subsetKeys` on catalog font rows — lets the supersede
 * path delete them alongside the primary object. Also reads the
 * legacy singular `variants.subsetKey` (latin-only era) so older
 * rows still clean up. Returns [] when absent/malformed. */
export const catalogFontSubsetKeysOf = (variantsJson: string | null): string[] => {
	if (variantsJson === null) return [];
	try {
		const parsed = JSON.parse(variantsJson) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
		const rec = parsed as Record<string, unknown>;
		const out: string[] = [];
		const seen = new Set<string>();
		const push = (key: unknown): void => {
			if (typeof key === "string" && key !== "" && !seen.has(key)) {
				seen.add(key);
				out.push(key);
			}
		};
		const list = rec["subsetKeys"];
		if (Array.isArray(list)) {
			for (const key of list) push(key);
		}
		// Legacy singular key — pre-multi-subset rows.
		push(rec["subsetKey"]);
		return out;
	} catch {
		return [];
	}
};

/**
 * Self-host manifest stored under `variants.fontAsset` on catalog
 * font rows — the {@link ThemeFontAsset} the managed-font cascade
 * serves for `meta.assetId` lookups whose theme_assets row has no
 * owning theme. Returns null on absent/malformed payloads.
 */
export const catalogFontAssetOf = (variantsJson: string | null): ThemeFontAsset | null => {
	if (variantsJson === null) return null;
	try {
		const parsed = JSON.parse(variantsJson) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const fontAsset = (parsed as Record<string, unknown>)["fontAsset"];
		if (typeof fontAsset !== "object" || fontAsset === null || Array.isArray(fontAsset)) {
			return null;
		}
		const faces = (fontAsset as Record<string, unknown>)["faces"];
		return Array.isArray(faces) ? (fontAsset as ThemeFontAsset) : null;
	} catch {
		return null;
	}
};

/** Unowned font rows — theme_id NULL. Two sources feed this set:
 * fonts-catalog uploads (variants.family set) and theme_assets
 * orphaned by a theme delete (ON DELETE SET NULL). */
export const listUnownedFontAssets = async (db: DbClient): Promise<ThemeAssetRow[]> =>
	db
		.select()
		.from(themeAssets)
		.where(and(isNull(themeAssets.themeId), eq(themeAssets.kind, "font")))
		.orderBy(desc(themeAssets.id));

/** Hard-delete one asset row — catalog supersede only; R2 cleanup is
 * the caller's job (keys are content-unique). */
export const deleteThemeAsset = async (db: DbClient, id: number): Promise<void> => {
	await db.delete(themeAssets).where(eq(themeAssets.id, id));
};

/**
 * Insert a ready catalog font row: theme_id NULL, kind "font", the
 * serving variants JSON ({family, weights?, fontAsset}) the local
 * adapter and the managed-font cascade resolve. `weights` is the CSS
 * font-weight list stamped on the @font-face rules AND mirrored at
 * `variants.weights` so the fonts catalog sync can populate
 * `font_families.weights` (absent/empty = 400 downstream). One face
 * is emitted per weight — all pointing at the same uploaded file,
 * which is harmless for static fonts. Variable fonts (an `fvar`
 * `wght` axis parsed by font-variations.ts) instead emit ONE face
 * with a `weightRange` (`font-weight:min max`) plus `variable`/
 * `weightAxis`/`unicodeRange` stamps on the variants JSON. Non-`wght`
 * `fvar` axes (`axes` input — wdth/opsz/slnt/ital/custom) are
 * sanitized, stamped on variants and copied onto every emitted face;
 * `variable` is set when EITHER axis kind is present.
 */
export const insertCatalogFontAsset = async (
	db: DbClient,
	input: {
		readonly family: string;
		readonly weights: readonly number[] | undefined;
		readonly r2Key: string;
		readonly format: string | undefined;
		/** `fvar` wght axis bounds (variable fonts) — when present and
		 * sane, faces emit a single `font-weight:min max` range instead
		 * of discrete weights and the axis is stamped on variants. */
		readonly weightAxis?: FontWeightAxis | undefined;
		/** `unicode-range` descriptor derived from the font's cmap —
		 * stamped on every face so browsers skip unneeded downloads. */
		readonly unicodeRange?: string | undefined;
		/** Non-`wght` `fvar` axes (wdth/opsz/slnt/ital/custom) —
		 * sanitized, stamped on variants and every emitted face.
		 * `wght` entries are ignored (weightAxis owns that axis). */
		readonly axes?: readonly FontVariationAxis[] | undefined;
		/** Real font subsets produced by font-subset.ts: sibling R2
		 * objects, one per covered charset, each carrying only its
		 * slice of the font's cmap coverage. When present, each weight
		 * emits one SUBSET face per charset (each with its own
		 * unicode-range) plus — only when `subsetFullUnicodeRange` is
		 * set — a FULL face carrying the complementary coverage of ALL
		 * subsets, so every face stays disjoint. The subset keys are
		 * stamped as `variants.subsetKeys` for supersede cleanup. */
		readonly subsets?:
			| readonly {
					readonly r2Key: string;
					readonly format: string | undefined;
					readonly unicodeRange: string;
			  }[]
			| undefined;
		/** unicode-range for the FULL-font face — the complement of
		 * ALL subset coverage. Absent → no full face is emitted (the
		 * subsets cover everything). Ignored without `subsets`. */
		readonly subsetFullUnicodeRange?: string | undefined;
	},
): Promise<ThemeAssetRow | null> => {
	const weights =
		input.weights === undefined
			? []
			: [...new Set(input.weights.filter(isCatalogWeight))].sort((a, b) => a - b);
	const url = themeAssetUrl(input.r2Key);
	// Sanitize the axis: finite numbers, CSS font-weight accepts 1–1000;
	// clamp rather than trust the fvar bytes blindly.
	const axis = input.weightAxis;
	const weightAxis =
		axis !== undefined &&
		Number.isFinite(axis.min) &&
		Number.isFinite(axis.default) &&
		Number.isFinite(axis.max) &&
		axis.min <= axis.default &&
		axis.default <= axis.max
			? {
					min: Math.min(1000, Math.max(1, axis.min)),
					default: Math.min(1000, Math.max(1, axis.default)),
					max: Math.min(1000, Math.max(1, axis.max)),
				}
			: undefined;
	const unicodeRange =
		typeof input.unicodeRange === "string" && input.unicodeRange.trim() !== ""
			? input.unicodeRange.trim()
			: undefined;
	const axes = sanitizeFontAxes(input.axes);
	const axisFaces = axes.length === 0 ? {} : { axes };
	const format = input.format === undefined ? {} : { format: input.format };
	// Real-subset siblings (font-subset.ts): sanitize like the other
	// stored-JSON-adjacent inputs — a malformed entry degrades to the
	// full-font-only face list rather than emitting bad CSS. Entries
	// without a usable r2Key/unicodeRange are dropped individually.
	const subsets = (input.subsets ?? [])
		.filter(
			(s): s is NonNullable<typeof s> =>
				typeof s === "object" &&
				s !== null &&
				typeof s.r2Key === "string" &&
				s.r2Key !== "" &&
				typeof s.unicodeRange === "string" &&
				s.unicodeRange.trim() !== "",
		)
		.map((s) => ({
			url: themeAssetUrl(s.r2Key),
			format: typeof s.format === "string" && s.format.trim() !== "" ? s.format.trim() : undefined,
			unicodeRange: s.unicodeRange.trim(),
			r2Key: s.r2Key,
		}));
	const subsetFullUnicodeRange =
		typeof input.subsetFullUnicodeRange === "string" && input.subsetFullUnicodeRange.trim() !== ""
			? input.subsetFullUnicodeRange.trim()
			: undefined;
	// Disjoint @font-face sources per weight: one face per charset
	// subset first, then the full font carrying only the complementary
	// coverage of ALL subsets (dropped entirely when the subsets cover
	// everything).
	const sources: {
		readonly url: string;
		readonly format?: string;
		readonly unicodeRange?: string;
	}[] =
		subsets.length === 0
			? [{ url, ...(unicodeRange === undefined ? {} : { unicodeRange }), ...format }]
			: [
					...subsets.map((s) => ({
						url: s.url,
						...(s.format === undefined ? {} : { format: s.format }),
						unicodeRange: s.unicodeRange,
					})),
					...(subsetFullUnicodeRange === undefined
						? []
						: [
								{
									url,
									...format,
									unicodeRange: subsetFullUnicodeRange,
								},
							]),
				];
	const faces: ThemeFontFace[] =
		weightAxis !== undefined
			? sources.map((s) => ({
					...s,
					weightRange: [weightAxis.min, weightAxis.max] as const,
					...axisFaces,
				}))
			: weights.length === 0
				? sources.map((s) => ({ ...s, ...axisFaces }))
				: weights.flatMap((weight) => sources.map((s) => ({ ...s, weight, ...axisFaces })));
	const variants = {
		family: input.family,
		...(weights.length === 0 ? {} : { weights }),
		...(weightAxis === undefined && axes.length === 0 ? {} : { variable: true }),
		...(weightAxis === undefined ? {} : { weightAxis }),
		...(axes.length === 0 ? {} : { axes }),
		...(unicodeRange === undefined ? {} : { unicodeRange }),
		...(subsets.length === 0 ? {} : { subsetKeys: subsets.map((s) => s.r2Key) }),
		fontAsset: { faces, fallback: null },
	};
	const rows = await db
		.insert(themeAssets)
		.values({
			themeId: null,
			kind: "font",
			r2Key: input.r2Key,
			status: "ready",
			variants: JSON.stringify(variants),
			createdAt: new Date(),
		})
		.returning();
	return (rows[0] as ThemeAssetRow | undefined) ?? null;
};

/** Write the job outcome: status + variants JSON (variant map, error
 * text or suggested seeds all ride the same column). */
export const completeThemeAsset = async (
	db: DbClient,
	id: number,
	input: { status: "ready" | "failed"; variants: unknown },
): Promise<void> => {
	await db
		.update(themeAssets)
		.set({ status: input.status, variants: JSON.stringify(input.variants) })
		.where(eq(themeAssets.id, id));
};

const parseBrand = (raw: string | null): ThemeBrand => {
	if (raw === null) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as ThemeBrand)
			: {};
	} catch {
		return {};
	}
};

/** Point a `theme_definitions.brand` field at a serving URL once the
 * asset job produced the canonical variant. */
export const setThemeBrandRef = async (
	db: DbClient,
	themeId: number,
	field: keyof ThemeBrand,
	url: string,
): Promise<void> => {
	const rows = await db
		.select()
		.from(themeDefinitions)
		.where(eq(themeDefinitions.id, themeId))
		.limit(1);
	const row = rows[0];
	if (row === undefined) return;
	const brand = { ...parseBrand(row.brand), [field]: url };
	await db
		.update(themeDefinitions)
		.set({ brand: JSON.stringify(brand), updatedAt: new Date() })
		.where(eq(themeDefinitions.id, themeId));
};

const parseFonts = (raw: string | null): ThemeFontConfig => {
	if (raw === null) return { delivery: "self-host" };
	try {
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as ThemeFontConfig)
			: { delivery: "self-host" };
	} catch {
		return { delivery: "self-host" };
	}
};

/**
 * Record a self-hosted font asset on the theme: forces delivery to
 * "self-host", fills `families[slot]` and `assets[family]`, preserving
 * every other family/slot already configured.
 */
export const upsertThemeFontAsset = async (
	db: DbClient,
	themeId: number,
	input: { family: string; slot: ThemeFontSlot; asset: ThemeFontAsset },
): Promise<ThemeFontConfig | null> => {
	const rows = await db
		.select()
		.from(themeDefinitions)
		.where(eq(themeDefinitions.id, themeId))
		.limit(1);
	const row = rows[0];
	if (row === undefined) return null;
	const fonts = parseFonts(row.fonts);
	const next: ThemeFontConfig = {
		delivery: "self-host",
		families: {
			...(fonts.families ?? {}),
			[input.slot]: input.family,
		},
		weights: fonts.weights,
		assets: {
			...(fonts.assets ?? {}),
			[input.family]: input.asset,
		},
	};
	await db
		.update(themeDefinitions)
		.set({ fonts: JSON.stringify(next), updatedAt: new Date() })
		.where(eq(themeDefinitions.id, themeId));
	return next;
};

// ---------- Google Fonts CSS (consumer-side download) ----------

export interface GoogleFontFace {
	readonly url: string;
	readonly weight: number;
	readonly format: string;
	/** css2 subset label from the preceding `/* subset *\/` comment
	 * ("latin", "latin-ext", "cyrillic", …); absent when the
	 * stylesheet carries no subset comments (legacy-UA response). */
	readonly subset?: string;
	/** `unicode-range` descriptor copied verbatim from the @font-face —
	 * css2 emits one per subset so a browser only fetches the files
	 * matching the page's scripts. Stored on the emitted face;
	 * present.ts revalidates the descriptor alphabet before CSS. */
	readonly unicodeRange?: string;
}

/** css2 stylesheet URL for a family+weights — the consumer fetches it
 * with a modern UA (woff2 URLs) and a legacy UA (truetype metrics probe). */
export const googleFontsCssUrl = (family: string, weights: readonly number[]): string => {
	const wght = [...new Set(weights.filter((w) => Number.isInteger(w) && w >= 100 && w <= 900))]
		.sort((a, b) => a - b)
		.join(";");
	const list = wght === "" ? "400" : wght;
	return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family.trim()).replaceAll("%20", "+")}:wght@${list}&display=swap`;
};

/** One parsed @font-face block from a css2/legacy Google Fonts
 * stylesheet — internal shape shared by both public parsers. */
interface GoogleFontBlock {
	readonly subset: string | null;
	readonly weight: number;
	readonly url: string;
	readonly format: string;
	readonly unicodeRange: string | undefined;
}

/** Walk @font-face blocks in order, tracking the preceding
 * `/* subset *\/` comment; blocks missing weight or src are dropped. */
const googleFontBlocks = (css: string): readonly GoogleFontBlock[] => {
	const blocks: { subset: string | null; body: string }[] = [];
	let lastSubset: string | null = null;
	const token = /\/\*\s*([a-z-]+)\s*\*\/|@font-face\s*\{([^}]*)\}/g;
	let match: RegExpExecArray | null;
	while ((match = token.exec(css)) !== null) {
		if (match[1] !== undefined) {
			lastSubset = match[1];
		} else {
			// The @font-face alternative always participates group 2 —
			/* v8 ignore next -- group 2 always participates here */
			blocks.push({ subset: lastSubset, body: match[2] ?? "" });
		}
	}
	const out: GoogleFontBlock[] = [];
	for (const block of blocks) {
		const weight = /font-weight:\s*(\d+)/.exec(block.body);
		const src = /src:\s*url\(([^)]+)\)/.exec(block.body);
		if (weight === null || src === null) continue;
		const unicodeRange = /unicode-range:\s*([^;]+)/.exec(block.body)?.[1]?.trim();
		out.push({
			subset: block.subset,
			weight: Number(weight[1]),
			url: src[1]!.trim(),
			format: /format\('([^']+)'\)/.exec(block.body)?.[1] ?? "woff2",
			unicodeRange: unicodeRange === undefined || unicodeRange === "" ? undefined : unicodeRange,
		});
	}
	return out;
};

const faceOf = (block: GoogleFontBlock): GoogleFontFace => ({
	url: block.url,
	weight: block.weight,
	format: block.format,
	...(block.subset === null ? {} : { subset: block.subset }),
	...(block.unicodeRange === undefined ? {} : { unicodeRange: block.unicodeRange }),
});

/**
 * EVERY @font-face in a modern css2 response, in document order —
 * css2 emits one block per unicode-range subset per weight (latin,
 * latin-ext, cyrillic, greek, vietnamese, …). The theme.font consumer
 * self-hosts each subset file and stamps the descriptor on the face
 * so the browser downloads only the scripts a page actually uses —
 * the same delivery the <link> path gets for free.
 */
export const parseGoogleFontsCssSubsets = (css: string): readonly GoogleFontFace[] =>
	googleFontBlocks(css).map(faceOf);

export const parseGoogleFontsCss = (css: string): readonly GoogleFontFace[] => {
	// Latin-only view for callers that want one file per weight (the
	// legacy-UA metrics probe): first latin block wins per weight,
	// otherwise the first block; sorted by weight. Subset/unicode-range
	// fields are stripped — this is the "one face per weight" shape.
	const byWeight = new Map<number, { face: GoogleFontFace; latin: boolean }>();
	for (const block of googleFontBlocks(css)) {
		const isLatin = block.subset === "latin";
		const face: GoogleFontFace = {
			url: block.url,
			weight: block.weight,
			format: block.format,
		};
		const existing = byWeight.get(block.weight);
		// First block wins unless a later latin block replaces a
		// non-latin pick for the same weight.
		if (existing === undefined || (isLatin && !existing.latin)) {
			byWeight.set(block.weight, { face, latin: isLatin });
		}
	}
	return [...byWeight.values()].map((entry) => entry.face).sort((a, b) => a.weight - b.weight);
};
