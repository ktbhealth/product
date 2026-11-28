import { ScrollTextIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { AuditPlatformPage } from "./platform-page.tsx";
import { auditConfig } from "./config.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the sidebar entries and page descriptors.
 * `panel.pages`/`pages` keep id/path/component only — the guard/loader
 * Effects run server-side and stay in ./index.ts. Dep ids are literals:
 * importing ./index.ts would pull the server graph into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const auditChromePlugin = definePlugin({
	i18nKeys: {
		groups: { Assurance: "panel_group_assurance" },
	},
	id: "audit.chrome",
	meta: { keywords: ["audit", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "audit.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/audit",
					label: "Audit log",
					icon: ScrollTextIcon,
					group: "Assurance",
				},
			},
		},
	],
});

export const auditPanelPlugin = definePlugin({
	id: "audit.panel",
	meta: { keywords: ["audit", "ui"] },
	requiredDeps: ["platform.panel", "audit.services"],
	panel: {
		pages: [{ id: "audit.admin", path: "/platform/audit", component: AuditPlatformPage }],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "audit.tables",
		meta: { keywords: ["audit", "tables"] },
		// Mirrors auditTablesPlugin (server index.ts) minus the tables
		// slice — drizzle schema never reaches the client bundle.
	}),
	definePlugin({
		id: "audit.services",
		// Mirrors auditServicesPlugin.requiredDeps (server index.ts) —
		// literal id: importing @ktb/platform would pull the server graph
		// into the client bundle. `meta` must match the server manifest
		// verbatim (parity test) — including the config document so the
		// /platform/plugins form renders; `configSchema` stays server-only.
		requiredDeps: ["platform.admin"],
		meta: {
			keywords: ["audit", "services"],
			name: "Audit",
			description: "Append-only admin audit log with hash-chained entries",
			icon: ScrollTextIcon,
			config: auditConfig,
		},
	}),
	auditChromePlugin,
	auditPanelPlugin,
];
