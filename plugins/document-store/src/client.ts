import { DatabaseIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { DocumentStoreCollectionPage, DocumentStoreCollectionsPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the console sidebar entry and the panel
 * page descriptors (id/path/component — guard/loader Effects stay
 * server-side in ./index.ts). Dep ids are literals: importing
 * ./index.ts would pull the server graph (Db, services, Layers) into
 * the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const documentStoreChromePlugin = definePlugin({
	id: "document-store.chrome",
	meta: { keywords: ["documents", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "document-store.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/document-store",
					label: "Document store",
					icon: DatabaseIcon,
					group: "System",
				},
			},
		},
	],
});

export const documentStorePanelPlugin = definePlugin({
	id: "document-store.panel",
	meta: { keywords: ["documents", "ui"] },
	requiredDeps: ["platform.panel", "document-store.admin"],
	panel: {
		pages: [
			{
				id: "document-store.collections",
				path: "/platform/document-store",
				component: DocumentStoreCollectionsPage,
			},
			{
				id: "document-store.collection",
				path: "/platform/document-store/*",
				component: DocumentStoreCollectionPage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors documentStoreTablesPlugin/documentStoreServicesPlugin/
	// documentStoreAdminPlugin (server index.ts) minus their
	// server-only slices — tables/services never reach the client
	// bundle, but the ids must exist so dep edges and enabled-state
	// filtering line up with the server registry.
	definePlugin({ id: "document-store.tables", meta: { keywords: ["documents", "tables"] } }),
	// optionalDeps mirrors the server manifest (parity test) — the
	// rbac ordering hint is client-visible dep data, not a service.
	definePlugin({
		id: "document-store.services",
		meta: { keywords: ["documents", "services"] },
		optionalDeps: ["rbac.services"],
	}),
	definePlugin({
		id: "document-store.admin",
		meta: { keywords: ["documents", "admin"] },
		requiredDeps: ["platform.admin", "document-store.services"],
	}),
	documentStoreChromePlugin,
	documentStorePanelPlugin,
];
