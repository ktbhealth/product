/**
 * Theme asset pipeline domain (P-082/PL-006 phase 4): asset kinds,
 * image variant planning, job payload contracts, `theme_assets` /
 * `theme_definitions` repo helpers and Google Fonts CSS parsing.
 *
 * Transport stays at the edge per ADR-0001: the api-route stores bytes
 * in R2 and enqueues via the jobs port; the queue consumer (host-side,
 * apps/web/src/lib/theme-jobs.ts) decodes images with the WASM
 * processor, writes derivatives back to R2 and calls the repo helpers
 * here. Everything in this module is plain TS — no workerd/node APIs —
 * so it stays unit-testable.
 */

import { Schema } from "effect";
import { eq } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { themeAssets, themeDefinitions } from "@ktb/db/schema";

import type {
	ThemeAssetKind,
	ThemeBrand,
	ThemeFontAsset,
	ThemeFontConfig,
	ThemeFontSlot,
} from "./types.ts";

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
}

export const insertThemeAsset = async (
	db: DbClient,
	input: { themeId: number; kind: ThemeAssetKind; r2Key: string | null },
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

export const parseGoogleFontsCss = (css: string): readonly GoogleFontFace[] => {
	// Walk @font-face blocks in order, tracking the preceding
	// /* subset */ comment so the latin block wins per weight.
	const blocks: { subset: string | null; body: string }[] = [];
	let lastSubset: string | null = null;
	const token = /\/\*\s*([a-z-]+)\s*\*\/|@font-face\s*\{([^}]*)\}/g;
	let match: RegExpExecArray | null;
	while ((match = token.exec(css)) !== null) {
		if (match[1] !== undefined) {
			lastSubset = match[1];
		} else {
			blocks.push({ subset: lastSubset, body: match[2] ?? "" });
		}
	}
	const byWeight = new Map<number, { face: GoogleFontFace; latin: boolean }>();
	for (const block of blocks) {
		const weight = /font-weight:\s*(\d+)/.exec(block.body);
		const src = /src:\s*url\(([^)]+)\)/.exec(block.body);
		const format = /format\('([^']+)'\)/.exec(block.body);
		if (weight === null || src === null) continue;
		const w = Number(weight[1]);
		const isLatin = block.subset === "latin";
		const existing = byWeight.get(w);
		// First block wins unless a later latin block replaces a
		// non-latin pick for the same weight.
		if (existing === undefined || (isLatin && !existing.latin)) {
			byWeight.set(w, {
				face: { url: src[1]!.trim(), weight: w, format: format?.[1] ?? "woff2" },
				latin: isLatin,
			});
		}
	}
	return [...byWeight.values()].map((entry) => entry.face).sort((a, b) => a.weight - b.weight);
};
