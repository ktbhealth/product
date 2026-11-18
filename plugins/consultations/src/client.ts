import { ClipboardListIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { ConsultationsPlatformPage } from "./platform-page.tsx";
import {
	ConsultationsDashboardSections,
	ConsultationsDashboardStats,
} from "./views/ConsultationsDashboard.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Every server entry keeps its id and dep
 * edges so topo order matches the server registry, but only
 * client-consumed contributions are carried: chrome regions (console
 * sidebar) and panel pages. `panel.pages` keep
 * id/path/component only — the loader/guard Effects run server-side and
 * stay in ./index.ts. tables/services/routes degrade to markers. Dep
 * ids are literals: importing ./index.ts would pull the server graph
 * into the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const consultationsChromePlugin = definePlugin({
	id: "consultations.chrome",
	meta: { keywords: ["consultations", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "consultations.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/consultations",
					label: "Consultations",
					icon: ClipboardListIcon,
					group: "Domain data",
				},
			},
		},
		// Mirrors consultationsChromePlugin's dashboard slots (server
		// index.ts) — same entries, literal dep ids.
		{
			id: "consultations.dashboard.stats",
			region: "portal.dashboard.stats",
			when: { paths: ["/platform"] },
			content: { kind: "component", component: ConsultationsDashboardStats },
		},
		{
			id: "consultations.dashboard.sections",
			region: "portal.dashboard.sections",
			when: { paths: ["/platform"] },
			content: { kind: "component", component: ConsultationsDashboardSections },
		},
	],
});

export const consultationsPanelPlugin = definePlugin({
	id: "consultations.panel",
	requiredDeps: ["platform.panel"],
	meta: {
		keywords: ["consultations", "ui"],
		name: "Consultations",
		description: "Consultation records and audio jobs",
		icon: ClipboardListIcon,
	},
	panel: {
		pages: [
			{
				id: "consultations.admin",
				path: "/platform/consultations",
				component: ConsultationsPlatformPage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	definePlugin({ id: "consultations.tables", meta: { keywords: ["consultations", "tables"] } }),
	definePlugin({
		id: "consultations.services",
		meta: { keywords: ["consultations", "services"] },
		requiredDeps: ["patients.services", "platform.admin"],
		// Mirrors consultationsServicesPlugin.optionalDeps (server index.ts).
		optionalDeps: [
			"audit.services",
			"integrity.services",
			"patient-access.services",
			"vault.services",
		],
	}),
	definePlugin({ id: "consultations.routes", meta: { keywords: ["consultations", "routes"] } }),
	consultationsChromePlugin,
	consultationsPanelPlugin,
];
