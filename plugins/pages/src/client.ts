import { FileTextIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { CustomNavLinks } from "./chrome.tsx";
import { PagesAdminConsolePage } from "./platform-page.tsx";
import { CustomPageView } from "./views/CustomPageView.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: chrome entries, the panel page descriptor
 * and the wildcard `pages` descriptor (id/path/component/context only —
 * the guard/loader Effects stay server-side in ./index.ts). Dep ids are
 * literals: importing ./index.ts would pull the server graph (Db,
 * services, Layers) into the client bundle. Keep in sync — parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const pagesChromePlugin = definePlugin({
	id: "pages.chrome",
	meta: { keywords: ["pages", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "pages.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/pages",
					label: "Pages",
					icon: FileTextIcon,
					group: "Presentation",
				},
			},
		},
		{
			id: "pages.nav",
			region: "app.header.nav",
			content: { kind: "component", component: CustomNavLinks },
		},
		// Mirrors the dialogAction entries in ./index.ts — the delete
		// dialog collects them from the client registry via
		// collectChrome(plugins, "rich-text.delete.actions", ...).
		{
			id: "pages.delete-action-unlink",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "pages.unlink-unpublish",
					owner: "pages",
					label: "Unlink & unpublish pages",
					description: "Pages keep their settings but lose the document and return to draft.",
					destructive: false,
				},
			},
		},
		{
			id: "pages.delete-action-delete",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "pages.delete-pages",
					owner: "pages",
					label: "Delete pages too",
					description: "Permanently deletes every page using this document.",
					destructive: true,
				},
			},
		},
	],
});

export const pagesRenderPlugin = definePlugin({
	id: "pages.render",
	meta: { keywords: ["pages", "ui"] },
	requiredDeps: ["pages.services"],
	optionalDeps: ["rich-text.services"],
	pages: [
		{
			id: "pages.custom",
			path: "/*",
			context: "app",
			component: CustomPageView,
		},
	],
});

export const pagesPanelPlugin = definePlugin({
	id: "pages.panel",
	meta: { keywords: ["pages", "ui"] },
	requiredDeps: ["platform.panel", "pages.services"],
	optionalDeps: ["rich-text.services"],
	panel: {
		pages: [
			{
				id: "pages.admin",
				path: "/platform/pages",
				component: PagesAdminConsolePage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors pagesTablesPlugin/pagesServicesPlugin (server index.ts)
	// minus their server-only slices — tables/services never reach the
	// client bundle, but the ids must exist so dep edges and enabled-state
	// filtering line up with the server registry.
	definePlugin({ id: "pages.tables", meta: { keywords: ["pages", "tables"] } }),
	definePlugin({
		id: "pages.services",
		meta: { keywords: ["pages", "services"] },
		requiredDeps: ["platform.admin"],
		optionalDeps: ["rich-text.services"],
	}),
	pagesChromePlugin,
	pagesRenderPlugin,
	pagesPanelPlugin,
];
