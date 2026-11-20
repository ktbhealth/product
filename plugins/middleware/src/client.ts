import { LayersIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { MiddlewarePage } from "./middleware-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Dep ids are literals: importing
 * ./index.ts would pull the server graph into the client bundle. Keep
 * in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */

/** Client mirror of middlewarePanelPlugin — `panel.pages` keep
 * id/path/component only; the guard/loader Effects run server-side
 * and stay in ./index.ts. */
export const middlewarePanelPlugin = definePlugin({
	id: "middleware.panel",
	meta: { keywords: ["platform", "admin", "ui"] },
	requiredDeps: ["platform.panel"],
	panel: {
		pages: [{ id: "middleware.stages", path: "/platform/middleware", component: MiddlewarePage }],
	},
});

/** Client mirror of middlewareChromePlugin — the console sidebar
 * entry in the `portal.sidebar` chrome region. */
export const middlewareChromePlugin = definePlugin({
	id: "middleware.chrome",
	meta: { keywords: ["platform", "ui"] },
	requiredDeps: ["platform.panel"],
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

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [middlewarePanelPlugin, middlewareChromePlugin];
