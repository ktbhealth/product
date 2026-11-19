import { RadioTowerIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { PubSubPlatformPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Dep ids are literals: importing
 * ./index.ts would pull the server graph into the client bundle. Keep
 * in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */

/**
 * Client mirror of pubsubServicesPlugin — services degrade to a marker;
 * requiredDeps stay literal (importing @ktb/platform would pull the
 * server graph into the client bundle).
 */
export const pubsubServicesPlugin = definePlugin({
	id: "pubsub.services",
	meta: { keywords: ["pubsub", "services"] },
	requiredDeps: ["platform.admin"],
});

/**
 * Client mirror of pubsubChromePlugin — the console sidebar entry lives
 * in the `portal.sidebar` chrome region under the Concurrency group.
 */
export const pubsubChromePlugin = definePlugin({
	id: "pubsub.chrome",
	meta: { keywords: ["pubsub", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "pubsub.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/pubsub",
					label: "Pubsub",
					icon: RadioTowerIcon,
					group: "Concurrency",
				},
			},
		},
	],
});

/**
 * Client mirror of pubsubPanelPlugin — `panel.pages` keep
 * id/path/component only; the guard/loader Effects run server-side and
 * stay in ./index.ts.
 */
export const pubsubPanelPlugin = definePlugin({
	id: "pubsub.panel",
	meta: { keywords: ["pubsub", "ui"] },
	requiredDeps: ["platform.panel", "pubsub.services"],
	panel: {
		pages: [{ id: "pubsub.topics", path: "/platform/pubsub", component: PubSubPlatformPage }],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	pubsubServicesPlugin,
	pubsubChromePlugin,
	pubsubPanelPlugin,
];
