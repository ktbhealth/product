import { PenLineIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { RichTextAdminConsolePage } from "./platform-page.tsx";

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
export const richTextChromePlugin = definePlugin({
	id: "rich-text.chrome",
	meta: { keywords: ["rich-text", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "rich-text.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/rich-text",
					label: "Rich text",
					icon: PenLineIcon,
					group: "Site",
				},
			},
		},
	],
});

export const richTextPanelPlugin = definePlugin({
	id: "rich-text.panel",
	meta: { keywords: ["rich-text", "ui"] },
	requiredDeps: ["platform.panel", "rich-text.services"],
	panel: {
		pages: [
			{
				id: "rich-text.admin",
				path: "/platform/rich-text",
				component: RichTextAdminConsolePage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors richTextTablesPlugin/richTextServicesPlugin (server index.ts)
	// minus their server-only slices — tables/services never reach the
	// client bundle, but the ids must exist so dep edges and enabled-state
	// filtering line up with the server registry.
	definePlugin({ id: "rich-text.tables", meta: { keywords: ["rich-text", "tables"] } }),
	definePlugin({
		id: "rich-text.services",
		meta: { keywords: ["rich-text", "services"] },
		requiredDeps: ["platform.admin"],
	}),
	richTextChromePlugin,
	richTextPanelPlugin,
];
