import { LayersIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin, adminConsolePage } from "@ktb/platform";
import { MiddlewareStages } from "@ktb/platform/middleware";

import { MiddlewarePage } from "./middleware-page.tsx";

/**
 * Middleware console plugin (PL-015 / P-110): the /platform/middleware
 * inspector — the ordered request-pipeline registry (stages table +
 * per-route effective chains), read-only v1. The page loader reads the
 * `MiddlewareStages` service the composition root provides from the
 * discovered registry plus the app's built-in stages; the page `guard`
 * re-checks PlatformAdmin like every console page (hard authz stays
 * inside services).
 */

export const middlewarePanelPlugin = definePlugin({
	id: "middleware.panel",
	meta: { keywords: ["platform", "admin", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "middleware.stages",
				path: "/platform/middleware",
				component: MiddlewarePage,
				// Hard 404 for non-admins — same contract as the /platform
				// layout guard.
				loader: () =>
					Effect.gen(function* () {
						const stages = yield* Effect.serviceOption(MiddlewareStages);
						if (Option.isNone(stages)) {
							return { stages: null, routes: null };
						}
						// The registry read degrades honestly: a failed
						// PluginStates lookup yields nulls → the view
						// renders the unavailable state.
						const [stageRows, routeRows] = yield* Effect.all(
							[
								stages.value.stages().pipe(Effect.orElseSucceed(() => null)),
								stages.value.routes().pipe(Effect.orElseSucceed(() => null)),
							],
							{ concurrency: "unbounded" },
						);
						return {
							stages: stageRows === null ? null : [...stageRows],
							routes: routeRows === null ? null : [...routeRows],
						};
					}),
			}),
		],
	},
});

/** Console sidebar entry — Runtime group like the other infra pages. */
export const middlewareChromePlugin = definePlugin({
	id: "middleware.chrome",
	meta: { keywords: ["platform", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "middleware.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/middleware",
					label: "Middleware",
					icon: LayersIcon,
					group: "Runtime",
				},
			},
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [middlewarePanelPlugin, middlewareChromePlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"middleware.panel": true;
		"middleware.chrome": true;
	}
}
