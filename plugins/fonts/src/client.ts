import { ServerIcon, TypeIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { FontProvidersPlatformPage, FontsPlatformPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Views, types and i18n are
 * client-safe; the Fonts service, tables and server fns stay in
 * ./index.ts. Dep ids are literals so the server graph never reaches
 * the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const fontsServicesPlugin = definePlugin({
	id: "fonts.services",
	meta: { keywords: ["fonts", "services"] },
	requiredDeps: ["platform.admin"],
});

export const fontsPanelPlugin = definePlugin({
	id: "fonts.panel",
	meta: { keywords: ["fonts", "ui"] },
	requiredDeps: ["platform.panel", "fonts.services"],
	panel: {
		pages: [
			{
				id: "fonts.providers",
				path: "/platform/fonts/providers",
				component: FontProvidersPlatformPage,
			},
			{ id: "fonts.catalog", path: "/platform/fonts", component: FontsPlatformPage },
		],
	},
});

export const fontsChromePlugin = definePlugin({
	id: "fonts.chrome",
	meta: { keywords: ["fonts", "ui"] },
	requiredDeps: ["platform.panel", "fonts.services"],
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

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	fontsServicesPlugin,
	fontsPanelPlugin,
	fontsChromePlugin,
];

// Client-safe re-exports — wire types only. i18n catalogs ship via the
// "./i18n" subpath export, not this manifest (client-contract arch rule).
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
export { FontProvidersPage, FontsPage } from "./views/index.ts";
