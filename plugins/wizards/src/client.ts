import { WandSparklesIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { WizardsAdminConsolePage } from "./platform-page.tsx";
import { WizardRunner } from "./views/WizardRunner.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: chrome entries, the panel page descriptor
 * and the `pages` runner descriptor (id/path/component/context only —
 * the loader Effects stay server-side in ./index.ts). Dep ids are
 * literals: importing ./index.ts would pull the server graph (Db,
 * services, Layers) into the client bundle. Keep in sync — parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const wizardsChromePlugin = definePlugin({
	id: "wizards.chrome",
	meta: { keywords: ["wizards", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "wizards.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/wizards",
					label: "Wizards",
					icon: WandSparklesIcon,
					group: "System",
				},
			},
		},
	],
});

export const wizardsRenderPlugin = definePlugin({
	id: "wizards.render",
	meta: { keywords: ["wizards", "ui"] },
	requiredDeps: ["wizards.services"],
	pages: [
		{
			id: "wizards.runner",
			path: "/wizards/*",
			context: "app",
			component: WizardRunner,
		},
	],
});

export const wizardsPanelPlugin = definePlugin({
	id: "wizards.panel",
	meta: { keywords: ["wizards", "ui"] },
	requiredDeps: ["platform.panel", "wizards.services"],
	panel: {
		pages: [
			{
				id: "wizards.admin",
				path: "/platform/wizards",
				component: WizardsAdminConsolePage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). Mirrors
 * wizardsTablesPlugin/wizardsServicesPlugin (server index.ts) minus
 * their server-only slices — tables/services never reach the client
 * bundle, but the ids must exist so dep edges and enabled-state
 * filtering line up with the server registry. */
export const plugins: readonly Plugin[] = [
	definePlugin({ id: "wizards.tables", meta: { keywords: ["wizards", "tables"] } }),
	definePlugin({
		id: "wizards.services",
		meta: { keywords: ["wizards", "services"] },
		requiredDeps: ["platform.admin"],
	}),
	wizardsChromePlugin,
	wizardsRenderPlugin,
	wizardsPanelPlugin,
];
