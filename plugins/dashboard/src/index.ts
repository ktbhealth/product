import * as Effect from "effect/Effect";
import { Option } from "effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";
import { LayoutDashboardIcon } from "lucide-react";

import { DashboardPlatformPage } from "./platform-page.tsx";

/**
 * Loader for the /platform index page (P-050): the dashboard is a
 * generic shell — domain data (patients, consultations, notifications)
 * no longer flows through it; each domain plugin contributes its own
 * portal.dashboard.* chrome slots fed by contexts the /platform layout
 * provides (T-125). What remains here is the runtime enable-state per
 * plugin (P-058) that powers the registered-plugins card — optional:
 * without the service every plugin renders as enabled, matching the
 * absence=enabled default.
 */
const dashboardLoader = () =>
	Effect.gen(function* () {
		const states = yield* Effect.serviceOption(PluginStates);
		const pluginStates = Option.isSome(states) ? yield* states.value.entries() : undefined;
		return { pluginStates };
	});

// Chrome contribution (P-060): the console sidebar entry lives in the
// `portal.sidebar` chrome region; the dep edge orders it after the
// platform shell like the retired panel entry.
export const dashboardChromePlugin = definePlugin({
	id: "dashboard.chrome",
	meta: { keywords: ["dashboard", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "dashboard.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform",
					label: "Dashboard",
					icon: LayoutDashboardIcon,
					exact: true,
				},
			},
		},
	],
});

// Panel (system console) contribution: the console landing page
// (/platform) is dispatched by the host's generic panel.pages route;
// this plugin declares the page descriptor. Only the platform shell is
// a hard dep — the dashboard renders as a generic shell and domain
// plugins extend it via the portal.dashboard.* chrome regions instead
// of being required by it (T-125).
export const dashboardPanelPlugin = definePlugin({
	id: "dashboard.panel",
	meta: { keywords: ["dashboard", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	panel: {
		pages: [
			{
				id: "dashboard.home",
				path: "/platform",
				component: DashboardPlatformPage,
				loader: dashboardLoader,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [dashboardChromePlugin, dashboardPanelPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"dashboard.chrome": true;
		"dashboard.panel": true;
	}
}
