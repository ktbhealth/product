import { LayoutTemplateIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { LayoutsAdminConsolePage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the chrome entries and the panel page
 * descriptor (component only — the guard/loader Effects stay
 * server-side in ./index.ts). Dep ids are literals: importing ./index.ts
 * would pull the server graph (Db, services, Layers) into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const layoutsChromePlugin = definePlugin({
	i18nKeys: {
		labels: {
			"/platform/layouts": "panel_nav_layouts",
		},
		groups: { Site: "panel_group_site" },
	},
	id: "layouts.chrome",
	meta: { keywords: ["layouts", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "layouts.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/layouts",
					label: "Layouts",
					icon: LayoutTemplateIcon,
					group: "Site",
				},
			},
		},
		// Mirrors the dialogAction entries in ./index.ts — the delete
		// dialog collects them from the client registry via
		// collectChrome(plugins, "rich-text.delete.actions", ...).
		{
			id: "layouts.delete-action-unlink",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "layouts.unlink-slots",
					owner: "layouts",
					label: "Empty layout slots",
					description:
						"Layouts keep their settings but the slots using this document render empty.",
					destructive: false,
				},
			},
		},
		{
			id: "layouts.delete-action-delete",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "layouts.delete-layouts",
					owner: "layouts",
					label: "Delete layouts too",
					description: "Permanently deletes every layout using this document.",
					destructive: true,
				},
			},
		},
	],
});

export const layoutsPanelPlugin = definePlugin({
	id: "layouts.panel",
	meta: { keywords: ["layouts", "ui"] },
	requiredDeps: ["platform.panel", "layouts.services"],
	panel: {
		pages: [
			{
				id: "layouts.admin",
				path: "/platform/layouts",
				component: LayoutsAdminConsolePage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors layoutsTablesPlugin/layoutsServicesPlugin (server index.ts)
	// minus their server-only slices — tables/services never reach the
	// client bundle, but the ids must exist so dep edges and enabled-state
	// filtering line up with the server registry.
	definePlugin({ id: "layouts.tables", meta: { keywords: ["layouts", "tables"] } }),
	definePlugin({
		id: "layouts.services",
		meta: { keywords: ["layouts", "services"] },
		requiredDeps: ["platform.admin"],
		optionalDeps: ["rich-text.services", "templates.services"],
	}),
	layoutsChromePlugin,
	layoutsPanelPlugin,
];
