import { ListTodoIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { QueuePlatformPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Dep ids are literals: importing
 * ./index.ts would pull the server graph into the client bundle. Keep
 * in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */

/**
 * Client mirror of queueServicesPlugin — services degrade to a marker;
 * requiredDeps stay literal (importing @ktb/platform would pull the
 * server graph into the client bundle).
 */
export const queueServicesPlugin = definePlugin({
	id: "queue.services",
	meta: { keywords: ["queue", "services"] },
	requiredDeps: ["platform.admin"],
});

/**
 * Client mirror of queueChromePlugin — the console sidebar entry lives
 * in the `portal.sidebar` chrome region under the Concurrency group.
 */
export const queueChromePlugin = definePlugin({
	id: "queue.chrome",
	meta: { keywords: ["queue", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "queue.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/queue",
					label: "Queue",
					icon: ListTodoIcon,
					group: "Concurrency",
				},
			},
		},
	],
});

/**
 * Client mirror of queuePanelPlugin — `panel.pages` keep
 * id/path/component only; the guard/loader Effects run server-side and
 * stay in ./index.ts.
 */
export const queuePanelPlugin = definePlugin({
	id: "queue.panel",
	meta: { keywords: ["queue", "ui"] },
	requiredDeps: ["platform.panel", "queue.services"],
	panel: {
		pages: [{ id: "queue.jobs", path: "/platform/queue", component: QueuePlatformPage }],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	queueServicesPlugin,
	queueChromePlugin,
	queuePanelPlugin,
];
