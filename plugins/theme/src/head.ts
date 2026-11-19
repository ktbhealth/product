/**
 * Head-tag projection for a resolved theme (P-082): favicon links,
 * font delivery links, og meta and the `:root`/`.dark` style block a
 * shell route's `head()` merges into its own tags. Pure — safe to call
 * from route `head()` on server and client.
 */

import type { ResolvedTheme } from "./types.ts";

/** Display name a theme gives the app: brand appName wins, then the
 * row's appName column. */
export const themeTitle = (theme: ResolvedTheme | null | undefined): string | null =>
	theme?.brand?.appName ?? theme?.appName ?? null;

interface HeadTag {
	readonly [key: string]: unknown;
}

export interface ThemeHead {
	readonly meta: readonly HeadTag[];
	readonly links: readonly HeadTag[];
	readonly styles: readonly { readonly children: string }[];
}

/**
 * Theme-derived head tags. `styles` carries ONE `<style>` block with
 * both `:root` and `.dark` overrides plus any `@font-face` rules —
 * exactly one emitter per page because resolution is per-shell (the
 * app shell resolves session→tenant→platform in the root loader and
 * skips console paths; each portal shell resolves its own instance).
 */
export const themeHead = (theme: ResolvedTheme): ThemeHead => {
	const links: HeadTag[] = [];
	const favicon = theme.brand?.favicon;
	if (typeof favicon === "string" && favicon.trim() !== "") {
		links.push({ rel: "icon", href: favicon });
		links.push({ rel: "apple-touch-icon", href: favicon });
	}
	for (const href of theme.fontLinks) links.push({ rel: "stylesheet", href });
	const ogImage = theme.brand?.ogImage;
	const meta: HeadTag[] =
		typeof ogImage === "string" && ogImage.trim() !== ""
			? [{ property: "og:image", content: ogImage }]
			: [];
	// styleCss + fontFaceCss are the resolved fields — they already
	// carry the managed-font cascade (presentTheme merges catalog
	// resolutions in), so heads never recompute from stored fonts.
	const css = `${theme.styleCss}\n${theme.fontFaceCss}`.trim();
	return {
		meta,
		links,
		styles: css === "" ? [] : [{ children: css }],
	};
};

/** Convenience: links + styles only (routes that keep their own meta). */
export const themeAssets = (
	theme: ResolvedTheme | null | undefined,
): {
	readonly links: readonly HeadTag[];
	readonly styles: readonly { readonly children: string }[];
} => {
	if (theme === null || theme === undefined) return { links: [], styles: [] };
	const head = themeHead(theme);
	return { links: head.links, styles: head.styles };
};

// googleFontLinks is re-exported for callers building custom heads.
export { googleFontLinks } from "./present.ts";
