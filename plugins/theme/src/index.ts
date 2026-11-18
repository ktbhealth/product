import { PaletteIcon } from "lucide-react";
import { physical } from "@tanstack/virtual-file-routes";
import * as Effect from "effect/Effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformHeaderPlugin } from "@ktb/platform-header";
import { platformAdminPlugin, platformPanelPlugin, PlatformAdmin } from "@ktb/platform";

import { ThemePlatformPage } from "./platform-page.tsx";
import { Theme, ThemeLive } from "./theme.ts";
import { ThemeAppBrand } from "./views/ThemeAppBrand.tsx";
import { ThemeHeaderAction } from "./views/ThemeHeaderAction.tsx";

/**
 * Theme plugin (P-082 / PL-006): white-label tokens, brand assets and
 * accessible palettes.
 *
 * - `theme.services` registers the `Theme` port (theme_definitions
 *   repo + scope fallback chain portal-instance → tenant → platform →
 *   null). Reads are open (public branding); writes are PlatformAdmin.
 * - `theme.panel` mounts /platform/theme — the admin editor with scope
 *   picker, seed editors, live preview, contrast report and publish.
 *   Guard 404s non-admins like every console page.
 * - `theme.header` contributes the app.header.actions popover for
 *   admin theme preview/switching; `optionalDeps` on
 *   platform.header documents the graceful-degradation contract
 *   (same pattern as jobs.header).
 *
 * SSR resolution itself lives in the host route loaders via
 * `themeScopeFn` — the plugin owns data + admin surface, not the
 * shells. Phase 4 (R2/queue asset uploads, font files, image
 * derivatives) is intentionally absent: theme_assets is a stub and
 * brand/font asset fields carry URLs only.
 */
export const themeServicesPlugin = definePlugin({
	id: "theme.services",
	meta: { keywords: ["theme", "services"] },
	requiredDeps: [platformAdminPlugin.id],
	services: ThemeLive,
});

export const themePanelPlugin = definePlugin({
	id: "theme.panel",
	meta: { keywords: ["theme", "ui"] },
	requiredDeps: [platformPanelPlugin.id, themeServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "theme.admin",
				path: "/platform/theme",
				component: ThemePlatformPage,
				// Hard 404 for non-admins — same contract as the /platform
				// layout guard; every service/fn call re-checks anyway.
				guard: () =>
					Effect.gen(function* () {
						const platformAdmin = yield* PlatformAdmin;
						return yield* platformAdmin.requireAdmin().pipe(
							Effect.as(true),
							Effect.catchTag("Forbidden", () => Effect.succeed(false)),
						);
					}),
				loader: () =>
					Effect.gen(function* () {
						const theme = yield* Theme;
						// Admin-gated inside the service; a Forbidden here means
						// the guard raced a revoked session — degrade to an
						// empty list rather than failing the page.
						return yield* theme.list().pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
					}).pipe(Effect.map((themes) => ({ themes }))),
			},
		],
	},
});

/** Header popover for admin theme preview — renders only for admins
 * (listThemesFn returns [] otherwise, and the component hides on empty). */
export const themeHeaderPlugin = definePlugin({
	id: "theme.header",
	meta: { keywords: ["theme", "ui"] },
	requiredDeps: [platformPanelPlugin.id, themeServicesPlugin.id],
	optionalDeps: [platformHeaderPlugin.id],
	chrome: [
		{
			id: "theme.header-action",
			region: "app.header.actions",
			// App-shell actions render `component` entries (the
			// `headerAction` kind is portal-shell chrome); the host
			// injects ChromeProps, which supplies `locale`.
			content: { kind: "component", component: ThemeHeaderAction },
		},
	],
});

/** App-shell brand block (PL-006 phase 7): renders the resolved theme's
 * brand mark in `app.header.brand` — the theme arrives via the
 * host-injected `ChromeProps.theme`, so this replaces the retired
 * hardcoded site brand. */
export const themeBrandPlugin = definePlugin({
	id: "theme.brand",
	meta: { keywords: ["theme", "ui"] },
	requiredDeps: [themeServicesPlugin.id],
	chrome: [
		{
			id: "theme.app-brand",
			region: "app.header.brand",
			content: { kind: "component", component: ThemeAppBrand },
		},
	],
});

/**
 * Asset pipeline routes (Phase 4): /api/theme/assets (upload + serve)
 * and /api/theme/fonts (Google Fonts enqueue) live in this package's
 * src/api-routes/ and mount under the shared "/api" prefix via a
 * physical() scan — same convention as jobs.routes/consultations.
 * The host's routes.ts must list this plugin for the subtree to mount.
 */
export const themeRoutesPlugin = definePlugin({
	id: "theme.routes",
	meta: { keywords: ["theme", "routes"] },
	requiredDeps: [themeServicesPlugin.id],
	routes: [physical("/api", "../../../../plugins/theme/src/api-routes")],
});

/** Sidebar entry under the System group (same mechanism as jobs.chrome). */
export const themeChromePlugin = definePlugin({
	id: "theme.chrome",
	meta: { keywords: ["theme", "ui"] },
	requiredDeps: [platformPanelPlugin.id, themeServicesPlugin.id],
	chrome: [
		{
			id: "theme.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/theme", label: "Theme", icon: PaletteIcon, group: "Presentation" },
			},
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	themeServicesPlugin,
	themeBrandPlugin,
	themePanelPlugin,
	themeHeaderPlugin,
	themeChromePlugin,
	themeRoutesPlugin,
];

export { Theme, ThemeLive } from "./theme.ts";
export { KTB_DEFAULT_THEME } from "./default-theme.ts";
export { findTheme, getThemeById, listThemes, upsertTheme, setThemeEnabled } from "./theme.ts";
export type { ThemeRow, ThemePublishInput } from "./theme.ts";
export {
	presentTheme,
	themeStyleCss,
	fontCssVars,
	googleFontLinks,
	fontFaceCss,
} from "./present.ts";
export type { ThemeDefinitionRow } from "./present.ts";
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
	themeHead,
	themeAssets,
	themeTitle,
	googleFontLinks as headGoogleFontLinks,
} from "./head.ts";
export type { ThemeHead } from "./head.ts";
export type {
	ResolvedTheme,
	ThemeBrand,
	ThemeFontConfig,
	ThemeResolveRequest,
	ThemeScopeKind,
	ThemeSeeds,
	ThemeSummary,
	ThemeTokens,
} from "./types.ts";
export { THEME_PREVIEW_COOKIE, THEME_PREVIEW_MAX_AGE } from "./types.ts";
export {
	themeScopeFn,
	listThemesFn,
	getThemeFn,
	publishThemeFn,
	setThemeEnabledFn,
	setThemePreviewFn,
} from "./fns.ts";
export { themeMessages, isThemeLocale, THEME_LOCALES } from "./i18n.ts";
export type { ThemeMessages, ThemeLocale } from "./i18n.ts";
export { ThemePlatformPage } from "./platform-page.tsx";
export type { ThemePageData } from "./platform-page.tsx";

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"theme.services": true;
		"theme.brand": true;
		"theme.panel": true;
		"theme.header": true;
		"theme.chrome": true;
		"theme.routes": true;
	}
}
