import { eq } from "drizzle-orm";

import type { FontCatalogFamily } from "@ktb/fonts/catalog";
import type { DbClient } from "@ktb/db";
import { themeDefinitions } from "@ktb/db/schema";

import { catalogFontAssetOf, getThemeAsset } from "./assets.ts";
import { parseThemeFontConfig } from "./present.ts";
import type { ThemeFontConfig, ThemeFontSlot, ThemeManagedFont } from "./types.ts";

/**
 * Managed-font cascade (fonts plugin → theme): pairs each font slot's
 * optional `sources.<slot>` reference ({providerId, family}) with the
 * synced `font_families` catalog and, for self-host providers, resolves
 * the stored `ThemeFontAsset` faces through the catalog row's
 * `meta.assetId` → theme_assets → owning theme's `fonts.assets`.
 *
 * Everything here is best-effort: unmatched, disabled-provider,
 * pending/failed or asset-less entries are skipped so the slot falls
 * back to its free-form `families.<slot>` name.
 */

const FONT_SLOTS: readonly ThemeFontSlot[] = ["sans", "heading", "mono"];

/** Provider adapter kind whose families deliver as a Google Fonts
 * stylesheet link; every other kind attempts the self-host asset
 * lookup (the "local" adapter stamps `meta.assetId`). */
export const GOOGLE_FONTS_PROVIDER_KIND = "googlefonts";

const metaAssetId = (meta: FontCatalogFamily["meta"]): number | null => {
	const value = meta?.["assetId"];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * Pure catalog match: for every slot with a `sources` entry, find the
 * READY catalog row on the referenced provider. Catalog weights win;
 * the theme's `fonts.weights` is the fallback when the provider lists
 * none (present.ts applies the default stack weights downstream).
 */
export const matchManagedFonts = (
	fonts: ThemeFontConfig,
	entries: readonly FontCatalogFamily[],
): readonly ThemeManagedFont[] => {
	const sources = fonts.sources;
	if (sources === undefined) return [];
	const matched: ThemeManagedFont[] = [];
	for (const slot of FONT_SLOTS) {
		const source = sources[slot];
		if (source === null || source === undefined) continue;
		const family = source.family.trim();
		if (family === "" || !Number.isInteger(source.providerId)) continue;
		const entry = entries.find(
			(e) => e.providerId === source.providerId && e.family === family && e.status === "ready",
		);
		if (entry === undefined) continue;
		matched.push({
			providerId: entry.providerId,
			family: entry.family,
			kind: entry.kind,
			weights: entry.weights.length > 0 ? [...entry.weights] : [...(fonts.weights ?? [])],
			assetId: metaAssetId(entry.meta),
		});
	}
	return matched;
};

/**
 * Fill `asset` on non-googlefonts managed fonts. Two storage shapes:
 *
 * - Theme-owned assets (`theme_assets.theme_id` set): the manifest
 *   lives on the owning theme's `fonts.assets[family]` (the font job
 *   writes it there).
 * - Fonts-catalog assets (`theme_id` NULL — uploads via
 *   /api/theme/catalog-fonts): the manifest rides the asset row's own
 *   `variants.fontAsset`.
 *
 * Any missing link degrades to the bare family name — never throws.
 */
export const loadManagedFontAssets = async (
	db: DbClient,
	managed: readonly ThemeManagedFont[],
): Promise<readonly ThemeManagedFont[]> => {
	const out: ThemeManagedFont[] = [];
	for (const font of managed) {
		if (font.kind === GOOGLE_FONTS_PROVIDER_KIND || font.assetId == null) {
			out.push(font);
			continue;
		}
		try {
			const assetRow = await getThemeAsset(db, font.assetId);
			if (assetRow === null) {
				out.push(font);
				continue;
			}
			// Catalog uploads carry no owning theme — the self-host
			// manifest is stamped on the asset row's variants instead.
			if (assetRow.themeId === null) {
				const asset = catalogFontAssetOf(assetRow.variants);
				out.push(asset === null ? font : { ...font, asset });
				continue;
			}
			const rows = await db
				.select({ fonts: themeDefinitions.fonts })
				.from(themeDefinitions)
				.where(eq(themeDefinitions.id, assetRow.themeId))
				.limit(1);
			const ownerFonts = parseThemeFontConfig(rows[0]?.fonts ?? null);
			const asset = ownerFonts?.assets?.[font.family];
			out.push(
				typeof asset === "object" && asset !== null
					? { ...font, asset: asset as ThemeManagedFont["asset"] }
					: font,
			);
		} catch {
			out.push(font);
		}
	}
	return out;
};
