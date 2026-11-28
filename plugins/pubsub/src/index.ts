import { RadioTowerIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { PubSubAdmin, PubSubAdminLive } from "./admin.ts";
import { PubSubPlatformPage } from "./platform-page.tsx";

/**
 * Pub/sub console services: the `PubSubAdmin` port aggregates the
 * signals behind /platform/pubsub — the merged topic sources and the
 * publish path. The dep edge orders it after the env-composed admin
 * gate.
 */
export const pubsubServicesPlugin = definePlugin({
	id: "pubsub.services",
	meta: { keywords: ["pubsub", "services"] },
	requiredDeps: [platformAdminPlugin.id],
	services: PubSubAdminLive,
});

// Chrome contribution: the console sidebar entry lives in the
// `portal.sidebar` chrome region under the Concurrency group; the dep
// edge orders it after the shell like the other panel entries.
export const pubsubChromePlugin = definePlugin({
	i18nKeys: {
		labels: {
			"/platform/pubsub": "panel_nav_pubsub",
		},
		groups: { Concurrency: "panel_group_concurrency" },
	},
	id: "pubsub.chrome",
	meta: { keywords: ["pubsub", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
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

// Panel (system console) contribution: /platform/pubsub is mounted by
// the platform plugin's physical route subtree; this plugin declares
// the page descriptor. The dep edge orders it after the shell and the
// pubsub services its loader consumes.
export const pubsubPanelPlugin = definePlugin({
	id: "pubsub.panel",
	meta: { keywords: ["pubsub", "ui"] },
	requiredDeps: [platformPanelPlugin.id, pubsubServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "pubsub.topics",
				path: "/platform/pubsub",
				component: PubSubPlatformPage,
				// Hard 404 for non-admins — same contract as the /platform
				// layout guard; every service call re-checks anyway.
				loader: () =>
					Effect.gen(function* () {
						const admin = yield* PubSubAdmin;
						// The section degrades honestly: a Forbidden or a
						// failed read yields null → the view renders the
						// unavailable state, never a fabricated empty list.
						const [topics, declaredTopics] = yield* Effect.all(
							[
								admin.topics().pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null))),
								admin
									.declaredTopics()
									.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null))),
							],
							{ concurrency: "unbounded" },
						);
						return { topics, declaredTopics };
					}),
			}),
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	pubsubServicesPlugin,
	pubsubChromePlugin,
	pubsubPanelPlugin,
];

export { PubSubAdmin } from "./admin.ts";
export { publishPubSubMessageFn } from "./fns.ts";
export type { PubSubPageData } from "./platform-page.tsx";
export type { PubSubPublishResult } from "./admin.ts";

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"pubsub.services": true;
		"pubsub.chrome": true;
		"pubsub.panel": true;
	}
}
