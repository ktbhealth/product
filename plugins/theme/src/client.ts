import { PaletteIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { ThemeEditorPage } from "./views/ThemeEditorPage.tsx";
import { ThemePlatformPage } from "./platform-page.tsx";
import { ThemeAppBrand } from "./views/ThemeAppBrand.tsx";
import { ColorSchemeToggle } from "./views/ColorSchemeToggle.tsx";
import { ThemeHeaderAction } from "./views/ThemeHeaderAction.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Views, types and i18n are
 * client-safe; the Theme service, tables and server fns stay in
 * ./index.ts. Dep ids are literals so the server graph never reaches
 * the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const themeServicesPlugin = definePlugin({
	id: "theme.services",
	meta: { keywords: ["theme", "services"] },
	requiredDeps: ["platform.admin"],
	optionalDeps: ["fonts.services"],
});

export const themeBrandPlugin = definePlugin({
	id: "theme.brand",
	meta: { keywords: ["theme", "ui"] },
	requiredDeps: ["theme.services"],
	chrome: [
		{
			id: "theme.app-brand",
			region: "app.header.brand",
			content: { kind: "component", component: ThemeAppBrand },
		},
	],
});

export const themePanelPlugin = definePlugin({
	id: "theme.panel",
	meta: { keywords: ["theme", "ui"] },
	requiredDeps: ["platform.panel", "theme.services"],
	panel: {
		pages: [
			{ id: "theme.admin", path: "/platform/theme", component: ThemePlatformPage },
			{ id: "theme.editor", path: "/platform/theme/editor", component: ThemeEditorPage },
		],
	},
});

export const themeHeaderPlugin = definePlugin({
	id: "theme.header",
	meta: { keywords: ["theme", "ui"] },
	requiredDeps: ["platform.panel", "theme.services"],
	optionalDeps: ["platform.header"],
	chrome: [
		{
			id: "theme.header-action",
			region: "app.header.actions",
			// App-shell actions render `component` entries (the
			// `headerAction` kind is portal-shell chrome); the host
			// injects ChromeProps, which supplies `locale`.
			content: { kind: "component", component: ThemeHeaderAction },
		},
		{
			id: "theme.color-scheme",
			region: "app.header.actions",
			// Light|dark|system toggle for every session — the admin
			// preview popover carries the same control for console users.
			content: { kind: "component", component: ColorSchemeToggle },
		},
		{
			id: "theme.portal-header-action",
			region: "portal.header.actions",
			// Same preview/switch popover inside the portal console
			// header — `headerAction` entries receive {locale, i18n}.
			content: {
				kind: "headerAction",
				id: "theme.preview",
				component: ThemeHeaderAction,
			},
		},
	],
});

export const themeChromePlugin = definePlugin({
	id: "theme.chrome",
	meta: { keywords: ["theme", "ui"] },
	requiredDeps: ["platform.panel", "theme.services"],
	chrome: [
		{
			id: "theme.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/theme", label: "Theme", icon: PaletteIcon, group: "Site" },
			},
		},
	],
});

/** Server-only route plugin (Phase 4 asset pipeline) — mirrored as a
 * stub like jobs.routes/consultations.routes so registry parity holds. */
const themeRoutesPlugin = definePlugin({
	id: "theme.routes",
	meta: { keywords: ["theme", "routes"] },
	requiredDeps: ["theme.services"],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	themeServicesPlugin,
	themeBrandPlugin,
	themePanelPlugin,
	themeHeaderPlugin,
	themeChromePlugin,
	themeRoutesPlugin,
];

// Client-safe re-exports — pure helpers and wire types only. i18n
// catalogs ship via the "./i18n" subpath export, not this manifest
// (client-contract arch rule).
export {
	deriveThemeTokens,
	tokensToCss,
	themeRadius,
	parseColor,
	contrastRatio,
	relativeLuminance,
	ensureContrast,
	ensurePair,
	contrastReport,
	measurePair,
	CONTRAST_PAIRS,
	srgbToOklch,
	oklchToLinearRgb,
	linearRgbToOklch,
	formatOklch,
} from "./palette.ts";
export type { Oklch, ContrastPair } from "./palette.ts";
export {
	presentTheme,
	themeStyleCss,
	fontCssVars,
	googleFontLinks,
	fontFaceCss,
} from "./present.ts";
export { themeHead, themeAssets, themeTitle } from "./head.ts";
export type { ThemeHead } from "./head.ts";
export type {
	ResolvedTheme,
	ThemeBrand,
	ThemeFontConfig,
	ThemeFontSource,
	ThemeFontSourceOption,
	ThemeManagedFont,
	ThemeResolveRequest,
	ThemeScopeKind,
	ThemeAssetSummary,
	ThemeSeeds,
	ThemeSummary,
	ThemeTokens,
} from "./types.ts";
export { THEME_PREVIEW_COOKIE, THEME_PREVIEW_MAX_AGE } from "./types.ts";
export { ThemePlatformPage } from "./platform-page.tsx";
export type { ThemePageData } from "./platform-page.tsx";
export {
	ThemeHeaderAction,
	ThemeAppBrand,
	ThemeBrandMark,
	ThemePreviewBanner,
	ThemePage,
} from "./views/index.ts";
