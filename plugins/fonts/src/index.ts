import { ServerIcon, TypeIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, PlatformAdmin } from "@ktb/platform";

import { FontProvidersPlatformPage, FontsPlatformPage } from "./platform-page.tsx";
import { Fonts, FontsServicesLive } from "./service.ts";

/**
 * Fonts plugin: font PROVIDERS (an extensible port + adapter registry)
 * and the synced family catalog, admin pages under /platform, a Site
 * sidebar group, and a FontHooks/EventBus fan-out so consumers (theme
 * font config is the first intended one) can cascade catalog changes.
 *
 * - `fonts.services` registers the `Fonts` port (font_providers +
 *   font_families repos), the `FontProviders` adapter registry (the
 *   built-in "local"/"googlefonts" adapters register at layer build)
 *   and the `FontHooks` change-notification registry. Every service
 *   method is PlatformAdmin-gated.
 * - `fonts.panel` mounts /platform/fonts/providers and /platform/fonts
 *   — the admin catalog surface. Guard 404s non-admins like every
 *   console page.
 * - `fonts.chrome` contributes the two Site sidebar entries.
 */
export const fontsServicesPlugin = definePlugin({
	id: "fonts.services",
	meta: { keywords: ["fonts", "services"] },
	requiredDeps: [platformAdminPlugin.id],
	services: FontsServicesLive,
});

// Hard 404 for non-admins — same contract as the /platform layout
// guard; every service/fn call re-checks anyway.
const fontsPanelGuard = () =>
	Effect.gen(function* () {
		const platformAdmin = yield* PlatformAdmin;
		return yield* platformAdmin.requireAdmin().pipe(
			Effect.as(true),
			Effect.catchTag("Forbidden", () => Effect.succeed(false)),
		);
	});

// Admin-gated inside the service; a Forbidden here means the guard
// raced a revoked session — degrade to empty payloads rather than
// failing the page.
const fontsProvidersLoader = () =>
	Effect.gen(function* () {
		const fonts = yield* Fonts;
		return yield* Effect.all({
			providers: fonts.listProviders().pipe(Effect.catchTag("Forbidden", () => Effect.succeed([]))),
			kinds: fonts
				.providerKinds()
				.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as readonly string[]))),
		});
	});

const fontsCatalogLoader = () =>
	Effect.gen(function* () {
		const fonts = yield* Fonts;
		return yield* Effect.all({
			providers: fonts.listProviders().pipe(Effect.catchTag("Forbidden", () => Effect.succeed([]))),
			families: fonts.listFamilies().pipe(Effect.catchTag("Forbidden", () => Effect.succeed([]))),
		});
	});

export const fontsPanelPlugin = definePlugin({
	id: "fonts.panel",
	meta: { keywords: ["fonts", "ui"] },
	requiredDeps: [platformPanelPlugin.id, fontsServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "fonts.providers",
				path: "/platform/fonts/providers",
				component: FontProvidersPlatformPage,
				guard: fontsPanelGuard,
				loader: fontsProvidersLoader,
			},
			{
				id: "fonts.catalog",
				path: "/platform/fonts",
				component: FontsPlatformPage,
				guard: fontsPanelGuard,
				loader: fontsCatalogLoader,
			},
		],
	},
});

/** Sidebar entries under the Site group (same mechanism as theme.chrome). */
export const fontsChromePlugin = definePlugin({
	id: "fonts.chrome",
	meta: { keywords: ["fonts", "ui"] },
	requiredDeps: [platformPanelPlugin.id, fontsServicesPlugin.id],
	chrome: [
		{
			id: "fonts.sidebar-providers",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/fonts/providers",
					label: "Font Providers",
					icon: ServerIcon,
					group: "Site",
				},
			},
		},
		{
			id: "fonts.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/fonts", label: "Fonts", icon: TypeIcon, group: "Site" },
			},
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	fontsServicesPlugin,
	fontsPanelPlugin,
	fontsChromePlugin,
];

export { Fonts, FontsLive, FontsServicesLive } from "./service.ts";
export type {
	CreateFontProviderInput,
	UpdateFontProviderInput,
	FontProviderRow,
	FontFamilyRow,
} from "./service.ts";
export {
	listProviderRows,
	findProviderRow,
	countFamiliesByProvider,
	insertProviderRow,
	updateProviderRow,
	setProviderEnabledRow,
	deleteProviderRow,
	listFamilyRows,
	findFamilyRow,
	insertFamilyRow,
	updateFamilyRow,
	summarizeProvider,
	summarizeFamily,
} from "./service.ts";
export { FontProviders, FontProvidersLive } from "./registry.ts";
export type { FontCatalogEntry, FontProviderAdapter } from "./registry.ts";
export { FontHooks, FontHooksLive, UnknownFontHook } from "./hooks.ts";
export type { FontHookHandle, FontHookHandler, FontHooksService } from "./hooks.ts";
export {
	FontsProviderChanged,
	FontsFamilySynced,
	FONTS_PROVIDER_CHANGED_TAG,
	FONTS_FAMILY_SYNCED_TAG,
} from "./events.ts";
export type { FontsProviderChangedEvent, FontsFamilySyncedEvent } from "./events.ts";
export { localFontProviderAdapter } from "./adapters/local.ts";
export {
	googleFontsAdapter,
	GOOGLE_FONTS_CATALOG,
	googleFontCssHref,
} from "./adapters/googlefonts.ts";
export {
	listFontProvidersFn,
	listFontProviderKindsFn,
	createFontProviderFn,
	updateFontProviderFn,
	setFontProviderEnabledFn,
	removeFontProviderFn,
	listFontFamiliesFn,
	syncFontProviderFn,
} from "./fns.ts";
export {
	fontMessages,
	isFontLocale,
	FONTS_LOCALES,
	I18N_NAMESPACE,
	i18nMessagesFor,
	BASE_LOCALE,
} from "./i18n.ts";
export type { FontMessages, FontLocale } from "./i18n.ts";
export type {
	FontProviderKind,
	FontProviderConfig,
	FontProviderSummary,
	FontFamilySummary,
	FontFamilyStatus,
} from "./types.ts";
export { FONT_FAMILY_STATUSES } from "./types.ts";
export { FontProvidersPlatformPage, FontsPlatformPage } from "./platform-page.tsx";
export type { FontProvidersPageData, FontsPageData } from "./platform-page.tsx";

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"fonts.services": true;
		"fonts.panel": true;
		"fonts.chrome": true;
	}
}
