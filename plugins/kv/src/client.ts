import { DatabaseIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { KvAdminConsolePage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the console sidebar entry and the panel
 * page descriptor (id/path/component — guard/loader Effects stay
 * server-side in ./index.ts). Dep ids are literals: importing
 * ./index.ts would pull the server graph (Db, services, Layers) into
 * the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const kvChromePlugin = definePlugin({
	id: "kv.chrome",
	meta: { keywords: ["kv", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "kv.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/kv",
					label: "Key-Value",
					icon: DatabaseIcon,
					group: "System",
				},
			},
		},
	],
});

export const kvPanelPlugin = definePlugin({
	id: "kv.panel",
	meta: { keywords: ["kv", "ui", "admin"] },
	requiredDeps: ["platform.panel", "kv.admin.services"],
	panel: {
		pages: [
			{
				id: "kv.entries",
				path: "/platform/kv",
				component: KvAdminConsolePage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors kvTablesPlugin/kvServicesPlugin/kvAdminServicesPlugin
	// (server index.ts) minus their server-only slices — tables,
	// services and Layers never reach the client bundle, but the ids
	// must exist so dep edges and enabled-state filtering line up with
	// the server registry.
	definePlugin({ id: "kv.tables", meta: { keywords: ["kv", "tables"] } }),
	definePlugin({ id: "kv.services", meta: { keywords: ["kv", "services"] } }),
	definePlugin({
		id: "kv.admin.services",
		meta: { keywords: ["kv", "services", "admin"] },
		requiredDeps: ["platform.admin"],
	}),
	kvChromePlugin,
	kvPanelPlugin,
];
