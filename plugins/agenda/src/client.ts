import { CalendarClockIcon } from "lucide-react";

import { definePlugin, type ChromeContribution, type Page, type Plugin } from "@ktb/kernel";

import { AgendaPortalPage } from "./views/AgendaPage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Every server entry keeps its id and dep
 * edges so topo order matches the server registry, but only
 * client-consumed contributions are carried: chrome regions (portal
 * sidebar) and page descriptors. `pages` keep id/path/component only —
 * the loader Effect runs server-side and stays in ./index.ts.
 * tables/services degrade to markers. Dep ids are literals:
 * importing ./index.ts would pull the server graph into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
const CLINICAL_INSTANCES = ["doctor", "secretary"] as const;

const agendaPages = (instance: (typeof CLINICAL_INSTANCES)[number]): Page[] => {
	const base = `/portal/${instance}`;
	return [
		{
			id: `agenda.${instance}.home`,
			path: `${base}/agenda`,
			component: AgendaPortalPage,
		},
	];
};

const agendaChrome = (instance: (typeof CLINICAL_INSTANCES)[number]): ChromeContribution[] => [
	{
		id: `agenda.${instance}.nav`,
		region: "portal.sidebar",
		portal: instance,
		content: {
			kind: "sidebarItem",
			item: {
				to: `/portal/${instance}/agenda`,
				label: "Agenda",
				icon: CalendarClockIcon,
				group: "Care",
			},
		},
	},
];

export const agendaTablesPlugin = definePlugin({
	id: "agenda.tables",
	meta: { keywords: ["agenda", "tables"] },
});

export const agendaServicesPlugin = definePlugin({
	id: "agenda.services",
	meta: { keywords: ["agenda", "services"] },
	// Mirrors agendaServicesPlugin.requiredDeps (server index.ts).
	requiredDeps: ["patients.services", "consultations.services"],
});

export const agendaPagesPlugin = definePlugin({
	id: "agenda.pages",
	meta: { keywords: ["agenda", "ui", "doctor", "secretary"] },
	requiredDeps: ["patients.services"],
	optionalDeps: ["clinician.portal"],
	pages: [...agendaPages("doctor"), ...agendaPages("secretary")],
});

export const agendaChromePlugin = definePlugin({
	id: "agenda.chrome",
	meta: { keywords: ["agenda", "ui", "doctor", "secretary"] },
	optionalDeps: ["clinician.portal"],
	chrome: [...agendaChrome("doctor"), ...agendaChrome("secretary")],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	agendaTablesPlugin,
	agendaServicesPlugin,
	agendaPagesPlugin,
	agendaChromePlugin,
];
