import { BookTemplateIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { TemplatesAdminConsolePage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the chrome entry and the panel page
 * descriptor (component only — the guard/loader Effects stay
 * server-side in ./index.ts). Dep ids are literals: importing ./index.ts
 * would pull the server graph (Db, services, Layers) into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const templatesChromePlugin = definePlugin({
	i18nKeys: {
		labels: {
			"/platform/templates": "panel_nav_templates",
		},
		groups: { Site: "panel_group_site" },
	},
	id: "templates.chrome",
	meta: { keywords: ["templates", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "templates.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/templates",
					label: "Templates",
					icon: BookTemplateIcon,
					group: "Site",
				},
			},
		},
	],
});

export const templatesPanelPlugin = definePlugin({
	id: "templates.panel",
	meta: { keywords: ["templates", "ui"] },
	requiredDeps: ["platform.panel", "templates.services"],
	panel: {
		pages: [
			{
				id: "templates.admin",
				path: "/platform/templates",
				component: TemplatesAdminConsolePage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors templatesTablesPlugin/templatesServicesPlugin (server
	// index.ts) minus their server-only slices — tables/services never
	// reach the client bundle, but the ids must exist so dep edges and
	// enabled-state filtering line up with the server registry.
	definePlugin({ id: "templates.tables", meta: { keywords: ["templates", "tables"] } }),
	definePlugin({
		id: "templates.services",
		meta: { keywords: ["templates", "services"] },
		requiredDeps: ["platform.admin"],
	}),
	templatesChromePlugin,
	templatesPanelPlugin,
];
