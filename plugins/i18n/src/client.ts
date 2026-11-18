import { LanguagesIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { I18nPlatformPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the panel sidebar entry and page descriptor (id/path/component —
 * guard/loader Effects stay server-side). Dep ids are literals:
 * importing ./index.ts would pull the server graph into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const i18nChromePlugin = definePlugin({
	id: "i18n.chrome",
	meta: { keywords: ["i18n", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "i18n.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n",
					label: "Translations",
					icon: LanguagesIcon,
					group: "Presentation",
				},
			},
		},
	],
});

export const i18nPanelPlugin = definePlugin({
	id: "i18n.panel",
	meta: { keywords: ["i18n", "ui", "admin"] },
	requiredDeps: ["platform.panel", "i18n.admin.services"],
	panel: {
		pages: [{ id: "i18n.messages", path: "/platform/i18n", component: I18nPlatformPage }],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "i18n.tables",
		meta: { keywords: ["i18n", "tables"] },
		// Mirrors i18nTablesPlugin (server index.ts) minus the tables
		// slice — drizzle schema never reaches the client bundle.
	}),
	definePlugin({
		id: "i18n.services",
		meta: { keywords: ["i18n", "services"] },
		// Mirrors i18nServicesPlugin (server index.ts).
	}),
	definePlugin({
		id: "i18n.admin.services",
		meta: { keywords: ["i18n", "services", "admin"] },
		// Mirrors i18nAdminServicesPlugin.requiredDeps minus the
		// services slice — literal ids keep the server graph out.
		requiredDeps: ["platform.admin", "rbac.services", "i18n.services"],
		optionalDeps: ["audit.services"],
	}),
	i18nChromePlugin,
	i18nPanelPlugin,
];
