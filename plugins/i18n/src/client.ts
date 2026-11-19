import { BoxesIcon, FileClockIcon, GlobeIcon, LanguagesIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import {
	I18nDraftsPlatformPage,
	I18nIndexRedirect,
	I18nLocalesPlatformPage,
	I18nNamespacesPlatformPage,
	I18nPlatformPage,
} from "./platform-page.tsx";

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
			id: "i18n.sidebar.messages",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n/messages",
					label: "Messages",
					icon: LanguagesIcon,
					group: "Internationalization",
				},
			},
		},
		{
			id: "i18n.sidebar.locales",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n/locales",
					label: "Locales",
					icon: GlobeIcon,
					group: "Internationalization",
				},
			},
		},
		{
			id: "i18n.sidebar.drafts",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n/drafts",
					label: "Drafts",
					icon: FileClockIcon,
					group: "Internationalization",
				},
			},
		},
		{
			id: "i18n.sidebar.namespaces",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/i18n/namespaces",
					label: "Namespaces",
					icon: BoxesIcon,
					group: "Internationalization",
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
		pages: [
			{ id: "i18n.index", path: "/platform/i18n", component: I18nIndexRedirect },
			{ id: "i18n.messages", path: "/platform/i18n/messages", component: I18nPlatformPage },
			{
				id: "i18n.locales",
				path: "/platform/i18n/locales",
				component: I18nLocalesPlatformPage,
			},
			{
				id: "i18n.drafts",
				path: "/platform/i18n/drafts",
				component: I18nDraftsPlatformPage,
			},
			{
				id: "i18n.namespaces",
				path: "/platform/i18n/namespaces",
				component: I18nNamespacesPlatformPage,
			},
		],
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
