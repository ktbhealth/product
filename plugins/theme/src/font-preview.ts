/**
 * Live font-preview model for the theme editor's Typography tab
 * (client-safe, pure): resolves each font slot's EFFECTIVE family —
 * a matched managed catalog source wins over the free-form
 * `families.<slot>` name, mirroring `presentTheme`'s cascade — and
 * derives the stylesheet links / `@font-face` CSS the browser needs
 * to actually render the specimen.
 *
 * Honesty rules:
 * - googlefonts delivery (managed `googlefonts` sources and free-form
 *   families under `delivery: "google-fonts"`) becomes css2 links via
 *   the same `googleFontCssHref` the cascade emits.
 * - Self-host faces come from the persisted row's `fontFaceCss` —
 *   managed "local" sources resolve server-side (catalog assetId →
 *   theme_assets → owning theme's `fonts.assets`), which the editor
 *   cannot recompute for an unpublished pick, so a freshly-picked
 *   managed self-host source previews in fallback until publish.
 * - Free-form families with no matching `@font-face`/link render in
 *   the fallback stack — the specimen never fakes a font.
 */

import { googleFontCssHref } from "@ktb/fonts/adapters/googlefonts";

import {
	fontAxesForFamily,
	fontCssVars,
	fontFaceCss,
	fontVariationSettingsForAxes,
	pinnableFontAxes,
	themeFontAxes,
} from "./present.ts";
import type {
	ThemeFontAxis,
	ThemeFontConfig,
	ThemeFontSlot,
	ThemeFontSourceOption,
} from "./types.ts";

const FONT_PREVIEW_SLOTS = ["sans", "heading", "mono"] as const satisfies readonly ThemeFontSlot[];

/** Provider adapter kind whose families deliver as a Google Fonts
 * stylesheet link — same constant managed-fonts.ts matches on. */
const GOOGLE_FONTS_KIND = "googlefonts";

/** Weight list assumed when neither the catalog option nor the theme
 * configures weights (mirrors present.ts MANAGED_DEFAULT_WEIGHTS). */
const DEFAULT_WEIGHTS: readonly number[] = [400, 500, 600, 700];

/** One slot's specimen inputs. */
interface FontPreviewSlot {
	readonly slot: ThemeFontSlot;
	/** Effective family name for display — managed catalog family wins
	 * over the free-form `families.<slot>`; null when neither is set. */
	readonly family: string | null;
	/** CSS font-family stack for the specimen ("" = inherit the page). */
	readonly fontFamily: string;
	/** `font-variation-settings` value for the slot — stored-asset
	 * axis defaults merged with the slot's `axisSettings` pins and
	 * managed catalog `meta.axes` ("" = none — specimens apply it
	 * inline since they sit outside the emitted slot rules). */
	readonly fontVariationSettings: string;
	/** Pinnable variable-font axes of the slot's resolved family —
	 * drives the editor's per-axis pin inputs (empty = static font
	 * or unknown metadata). */
	readonly axes: readonly ThemeFontAxis[];
	/** Candidate weights for the specimen weight switcher. */
	readonly weights: readonly number[];
}

export interface FontPreviewModel {
	readonly slots: readonly FontPreviewSlot[];
	/** Google Fonts stylesheet hrefs the preview must load (deduped by
	 * family, slot order — same ordering rule as presentTheme). */
	readonly links: readonly string[];
	/** `@font-face` CSS to inject for self-hosted faces. */
	readonly faceCss: string;
}

/** Persisted-row context the client cannot recompute: the resolved
 * `fontFaceCss` (managed faces included) and the stored delivery mode
 * (decides whether stored faces are already covered). */
export interface FontPreviewPersisted {
	readonly faceCss?: string;
	readonly delivery?: ThemeFontConfig["delivery"] | null;
}

/** Union two axis lists by tag — first list wins on duplicates
 * (stored asset faces precede catalog meta, mirroring publish). */
const mergeAxes = (
	primary: readonly ThemeFontAxis[],
	extra: readonly ThemeFontAxis[],
): ThemeFontAxis[] => {
	if (extra.length === 0) return [...primary];
	const seen = new Set(primary.map((axis) => axis.tag));
	return [...primary, ...extra.filter((axis) => !seen.has(axis.tag))];
};

/** Sorted, deduped, range-checked weight list; empty input falls back
 * to the default stack (same tolerance as googleFontLinks). */
const previewWeights = (weights: readonly number[] | undefined): readonly number[] => {
	const list = (weights ?? []).filter((w) => Number.isInteger(w) && w >= 100 && w <= 900);
	return list.length === 0 ? DEFAULT_WEIGHTS : [...new Set(list)].sort((a, b) => a - b);
};

/** Catalog option bound to `fonts.sources.<slot>` — matches on
 * (providerId, trimmed family) exactly like presentTheme's cascade. */
const matchSourceOption = (
	fonts: ThemeFontConfig | null,
	slot: ThemeFontSlot,
	sources: readonly ThemeFontSourceOption[],
): ThemeFontSourceOption | null => {
	const source = fonts?.sources?.[slot];
	if (source === null || source === undefined) return null;
	const family = source.family.trim();
	if (family === "" || !Number.isInteger(source.providerId)) return null;
	return sources.find((o) => o.providerId === source.providerId && o.family === family) ?? null;
};

/**
 * Build the preview model for the draft `fonts` config. `persisted`
 * carries the loaded row's resolved `fontFaceCss` + delivery so
 * managed self-host faces (unresolvable client-side) still render
 * when the draft binding matches the stored one.
 */
export const fontPreviewModel = (
	fonts: ThemeFontConfig | null,
	sources: readonly ThemeFontSourceOption[],
	persisted: FontPreviewPersisted = {},
): FontPreviewModel => {
	// Slot → matched catalog option; managed family names override the
	// free-form families in the effective config (presentTheme parity).
	const matches = new Map<ThemeFontSlot, ThemeFontSourceOption>();
	const managedNames: Partial<Record<ThemeFontSlot, string>> = {};
	const managedAssetFamilies = new Set<string>();
	const managedGoogleFamilies = new Set<string>();
	for (const slot of FONT_PREVIEW_SLOTS) {
		const option = matchSourceOption(fonts, slot, sources);
		if (option === null) continue;
		matches.set(slot, option);
		managedNames[slot] = option.family;
		if (option.providerKind === GOOGLE_FONTS_KIND) {
			managedGoogleFamilies.add(option.family);
		} else {
			managedAssetFamilies.add(option.family);
		}
	}

	const effectiveFonts: ThemeFontConfig | null =
		fonts === null ? null : { ...fonts, families: { ...(fonts.families ?? {}), ...managedNames } };
	const vars = fontCssVars(effectiveFonts);
	const freeWeights = previewWeights(fonts?.weights);

	// Managed catalog `meta.axes` by family — the same fvar data the
	// server stamps onto resolved self-host faces, available client-side
	// through the source options so specimens AND pin inputs see the
	// axes before publish. Stored `fonts.assets` axes take precedence
	// per tag (they are what publish emits for unmanaged families).
	const managedAxesByFamily = new Map<string, ThemeFontAxis[]>();
	for (const option of matches.values()) {
		const axes = pinnableFontAxes(themeFontAxes(option.axes));
		if (axes.length === 0) continue;
		managedAxesByFamily.set(
			option.family,
			mergeAxes(managedAxesByFamily.get(option.family) ?? [], axes),
		);
	}

	// Resolved weights per slot: catalog weights win, then the theme's
	// `fonts.weights`, then the default stack — the same precedence
	// matchManagedFonts + presentTheme apply.
	const resolved = new Map<
		ThemeFontSlot,
		{ option: ThemeFontSourceOption | null; weights: readonly number[] }
	>();
	for (const slot of FONT_PREVIEW_SLOTS) {
		const option = matches.get(slot) ?? null;
		resolved.set(slot, {
			option,
			weights:
				option !== null && option.weights.length > 0 ? previewWeights(option.weights) : freeWeights,
		});
	}

	const slots: FontPreviewSlot[] = FONT_PREVIEW_SLOTS.map((slot) => {
		const { option, weights } = resolved.get(slot)!;
		// Effective free-form name mirrors fontCssVars on the managed-
		// overridden config: heading falls back to the sans family.
		const families = effectiveFonts?.families;
		const free =
			(families?.[slot] ?? (slot === "heading" ? families?.sans : undefined))?.trim() ?? "";
		const family = option?.family ?? (free === "" ? null : free);
		// Axes of the resolved family: stored self-host asset faces
		// first, then catalog meta.axes for managed families (which may
		// also inherit another slot's managed family — e.g. heading
		// falling back to a managed sans).
		const axes =
			family === null
				? []
				: mergeAxes(fontAxesForFamily(fonts, family), managedAxesByFamily.get(family) ?? []);
		return {
			slot,
			family,
			// `--font-body` mirrors `--font-sans` (fontCssVars alias) —
			// same lookup the Tokens-tab specimens use.
			fontFamily: vars[slot === "sans" ? "--font-body" : `--font-${slot}`] ?? "",
			// Same slot→family→axes→pins resolution the emitted style
			// block uses, computed from the union above so managed
			// catalog axes apply before publish too.
			fontVariationSettings: fontVariationSettingsForAxes(axes, fonts?.axisSettings?.[slot]),
			axes,
			weights,
		};
	});

	// Stylesheet links, slot order, deduped by family — managed
	// googlefonts sources first per slot, then the free-form family
	// when delivery opts in and no managed source claims the name.
	const links: string[] = [];
	const linked = new Set<string>();
	// Callers guarantee a non-empty trimmed name (managed matches
	// require a non-blank source family; the free-form pass checks
	// `name !== ""` first) — dedupe by family, first occurrence wins.
	const link = (family: string, weights: readonly number[]) => {
		const name = family.trim();
		if (linked.has(name)) return;
		linked.add(name);
		links.push(googleFontCssHref(name, weights));
	};
	for (const slot of FONT_PREVIEW_SLOTS) {
		const { option, weights } = resolved.get(slot)!;
		if (option?.providerKind === GOOGLE_FONTS_KIND) {
			link(option.family, weights);
		}
		if (fonts?.delivery === "google-fonts") {
			const name = fonts.families?.[slot]?.trim() ?? "";
			if (name !== "" && !managedGoogleFamilies.has(name)) {
				link(name, freeWeights);
			}
		}
	}

	// Stored self-host faces: `fonts.assets` minus families a matched
	// non-googlefonts source now owns (presentTheme's genericAssets
	// filter). Emitted only when the persisted row did NOT already
	// cover them — persisted `fontFaceCss` carries both stored and
	// managed faces, so re-emitting would duplicate every rule.
	const genericAssets =
		fonts?.assets === undefined
			? fonts?.assets
			: Object.fromEntries(
					Object.entries(fonts.assets).filter(([family]) => !managedAssetFamilies.has(family)),
				);
	const storedFaces =
		fonts?.delivery === "self-host" && persisted.delivery !== "self-host"
			? fontFaceCss({ delivery: "self-host", assets: genericAssets })
			: "";
	const faceCss = [persisted.faceCss ?? "", storedFaces].filter((css) => css !== "").join("\n");

	return { slots, links, faceCss };
};
