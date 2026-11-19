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

const fontFamiliesOf = (fontsJson: string | null): { families: string[]; weights?: number[] } => {
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

const variantFamilyOf = (variantsJson: string | null): string | null => {
	const variants = asRecord(parseJson(variantsJson));
	const family = variants?.["family"];
	return typeof family === "string" && family.trim() !== "" ? family.trim() : null;
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
				const direct = variantFamilyOf(row.variants);
				const resolved =
					direct !== null
						? { families: [direct], weights: undefined }
						: fontFamiliesOf(row.themeFonts);
				for (const family of resolved.families) {
					if (byFamily.has(family)) continue;
					byFamily.set(family, {
						family,
						...(resolved.weights === undefined ? {} : { weights: resolved.weights }),
						meta: { source: "local", assetId: row.assetId },
					});
				}
			}
			return [...byFamily.values()];
		}),
};
