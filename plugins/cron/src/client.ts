import { CalendarClockIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { CronPlatformPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Dep ids are literals: importing
 * ./index.ts would pull the server graph into the client bundle. Keep
 * in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */

/**
 * Client mirror of cronServicesPlugin — services degrade to a marker;
 * requiredDeps stay literal (importing @ktb/platform would pull the
 * server graph into the client bundle).
 */
export const cronServicesPlugin = definePlugin({
	id: "cron.services",
	meta: { keywords: ["cron", "services"] },
	requiredDeps: ["platform.admin"],
});

/**
 * Client mirror of cronChromePlugin — the console sidebar entry lives
 * in the `portal.sidebar` chrome region under the Concurrency group.
 */
export const cronChromePlugin = definePlugin({
	i18nKeys: {
		labels: {
			"/platform/cron": "panel_nav_cron",
		},
		groups: { Concurrency: "panel_group_concurrency" },
	},
	id: "cron.chrome",
	meta: { keywords: ["cron", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "cron.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/cron",
					label: "Cronjobs",
					icon: CalendarClockIcon,
					group: "Concurrency",
				},
			},
		},
	],
});

/**
 * Client mirror of cronPanelPlugin — `panel.pages` keep
 * id/path/component only; the guard/loader Effects run server-side and
 * stay in ./index.ts.
 */
export const cronPanelPlugin = definePlugin({
	id: "cron.panel",
	meta: { keywords: ["cron", "ui"] },
	requiredDeps: ["platform.panel", "cron.services"],
	panel: {
		pages: [{ id: "cron.jobs", path: "/platform/cron", component: CronPlatformPage }],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [cronServicesPlugin, cronChromePlugin, cronPanelPlugin];
