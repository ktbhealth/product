import * as Effect from "effect/Effect";

import type { FontCatalogEntry, FontProviderAdapter } from "../registry.ts";

/**
 * "googlefonts" adapter — an embedded catalog of common Google Fonts
 * families with their typical weight coverage. The catalog is static
 * (no network at sync time); `googleFontCssHref` builds the css2
 * stylesheet URL consumers (theme `fontLinks`) can embed later.
 */

interface GoogleFontSpec {
	readonly family: string;
	readonly weights: readonly number[];
}

const FULL = [400, 500, 600, 700] as const;

const SPECS: readonly GoogleFontSpec[] = [
	{ family: "Inter", weights: FULL },
	{ family: "Roboto", weights: [400, 500, 700, 900] },
	{ family: "Open Sans", weights: [400, 600, 700, 800] },
	{ family: "Lato", weights: [400, 700, 900] },
	{ family: "Montserrat", weights: [400, 500, 600, 700, 800] },
	{ family: "Poppins", weights: [400, 500, 600, 700] },
	{ family: "Source Sans 3", weights: [400, 600, 700] },
	{ family: "Source Serif 4", weights: [400, 600, 700] },
	{ family: "Nunito", weights: [400, 600, 700, 800] },
	{ family: "Raleway", weights: [400, 500, 600, 700, 800] },
	{ family: "Rubik", weights: [400, 500, 700] },
	{ family: "Work Sans", weights: [400, 500, 600, 700] },
	{ family: "PT Sans", weights: [400, 700] },
	{ family: "PT Serif", weights: [400, 700] },
	{ family: "Noto Sans", weights: [400, 500, 700] },
	{ family: "Noto Serif", weights: [400, 700] },
	{ family: "Oswald", weights: [400, 500, 600, 700] },
	{ family: "Roboto Condensed", weights: [400, 700] },
	{ family: "Roboto Mono", weights: [400, 500, 700] },
	{ family: "JetBrains Mono", weights: [400, 500, 700] },
	{ family: "IBM Plex Sans", weights: [400, 500, 600, 700] },
	{ family: "IBM Plex Mono", weights: [400, 500, 600, 700] },
	{ family: "Fira Sans", weights: [400, 500, 700] },
	{ family: "Fira Code", weights: [400, 500, 700] },
	{ family: "Merriweather", weights: [400, 700, 900] },
	{ family: "Lora", weights: [400, 500, 600, 700] },
	{ family: "Playfair Display", weights: [400, 500, 600, 700, 800] },
	{ family: "Merriweather Sans", weights: [400, 700, 800] },
	{ family: "Libre Franklin", weights: [400, 500, 600, 700, 800] },
	{ family: "Ubuntu", weights: [400, 500, 700] },
	{ family: "Karla", weights: [400, 700, 800] },
	{ family: "Mulish", weights: [400, 500, 600, 700, 800, 900] },
	{ family: "Manrope", weights: [400, 500, 600, 700, 800] },
	{ family: "DM Sans", weights: [400, 500, 700] },
	{ family: "DM Serif Display", weights: [400] },
	{ family: "DM Serif Text", weights: [400, 700] },
	{ family: "Archivo", weights: [400, 500, 600, 700] },
	{ family: "Barlow", weights: [400, 500, 600, 700] },
	{ family: "Titillium Web", weights: [400, 600, 700, 900] },
	{ family: "Cabin", weights: [400, 700] },
	{ family: "Jost", weights: [400, 500, 600, 700] },
	{ family: "Josefin Sans", weights: [400, 500, 600, 700] },
	{ family: "Outfit", weights: [400, 500, 600, 700] },
	{ family: "Sora", weights: [400, 600, 700, 800] },
	{ family: "Space Grotesk", weights: [400, 500, 600, 700] },
];

/** The static catalog — also exported for tests/tooling. */
export const GOOGLE_FONTS_CATALOG: readonly FontCatalogEntry[] = SPECS.map((spec) => ({
	family: spec.family,
	weights: spec.weights,
	meta: { source: "googlefonts" },
}));

/**
 * Google Fonts css2 stylesheet URL for a family + weight list —
 * `https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap`.
 * Intended for theme `fontLinks`/`@import` consumption.
 */
export const googleFontCssHref = (family: string, weights: readonly number[]): string => {
	const list = [...new Set(weights)].sort((a, b) => a - b).join(";");
	const encoded = encodeURIComponent(family.trim()).replaceAll("%20", "+");
	return `https://fonts.googleapis.com/css2?family=${encoded}:wght@${list}&display=swap`;
};

export const googleFontsAdapter: FontProviderAdapter = {
	kind: "googlefonts",
	list: () => Effect.succeed(GOOGLE_FONTS_CATALOG),
};
