import { BracesIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { SchemasAdminConsolePage } from "./platform-page.tsx";

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
export const schemasChromePlugin = definePlugin({
	i18nKeys: {
		labels: {
			"/platform/schemas": "panel_nav_schemas",
		},
		groups: { Site: "panel_group_site" },
	},
	id: "schemas.chrome",
	meta: { keywords: ["schemas", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "schemas.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/schemas",
					label: "Schemas",
					icon: BracesIcon,
					group: "Site",
				},
			},
		},
	],
});

export const schemasPanelPlugin = definePlugin({
	id: "schemas.panel",
	meta: { keywords: ["schemas", "ui"] },
	requiredDeps: ["platform.panel", "schemas.services"],
	panel: {
		pages: [
			{
				id: "schemas.admin",
				path: "/platform/schemas",
				component: SchemasAdminConsolePage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors schemasTablesPlugin/schemasServicesPlugin (server index.ts)
	// minus their server-only slices — tables/services never reach the
	// client bundle, but the ids must exist so dep edges and enabled-state
	// filtering line up with the server registry.
	definePlugin({ id: "schemas.tables", meta: { keywords: ["schemas", "tables"] } }),
	definePlugin({
		id: "schemas.services",
		meta: { keywords: ["schemas", "services"] },
		requiredDeps: ["platform.admin"],
	}),
	schemasChromePlugin,
	schemasPanelPlugin,
];
