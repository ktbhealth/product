import { ActivityIcon, ScrollTextIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { AuditActivityPage } from "./activity-page.tsx";
import { AuditPlatformPage } from "./platform-page.tsx";

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
	id: "audit.chrome",
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
					group: "Governance",
				},
			},
		},
		{
			id: "audit.activity.sidebar",
			region: "portal.sidebar",
			portal: "clinician",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/portal/clinician/activity",
					label: "Activity",
					icon: ActivityIcon,
					group: "Governance",
				},
			},
		},
	],
});

export const auditPanelPlugin = definePlugin({
	id: "audit.panel",
	requiredDeps: ["platform.panel", "audit.services"],
	panel: {
		pages: [{ id: "audit.admin", path: "/platform/audit", component: AuditPlatformPage }],
	},
});

export const auditActivityPlugin = definePlugin({
	id: "audit.activity",
	requiredDeps: ["audit.services"],
	pages: [
		{
			id: "audit.activity",
			path: "/portal/clinician/activity",
			component: AuditActivityPage,
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "audit.tables",
		// Mirrors auditTablesPlugin (server index.ts) minus the tables
		// slice — drizzle schema never reaches the client bundle.
	}),
	definePlugin({
		id: "audit.services",
		// Mirrors auditServicesPlugin.requiredDeps (server index.ts) —
		// literal id: importing @ktb/platform would pull the server graph
		// into the client bundle.
		requiredDeps: ["platform.admin"],
	}),
	auditChromePlugin,
	auditPanelPlugin,
	auditActivityPlugin,
];
