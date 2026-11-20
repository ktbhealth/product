import { definePlugin, type Plugin } from "@ktb/kernel";

import { SiteBuilderEditorPage } from "./editor-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the two wildcard panel page descriptors
 * (component only — the guard/loader Effects and the route-registry
 * `contributions` stay server-side in ./index.ts). Dep ids are
 * literals: importing ./index.ts would pull the server graph into the
 * client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const siteBuilderPanelPlugin = definePlugin({
	id: "site-builder.panel",
	meta: { keywords: ["site", "ui"] },
	requiredDeps: ["platform.panel"],
	optionalDeps: ["pages.services", "layouts.services"],
	panel: {
		pages: [
			{
				id: "site-builder.page-editor",
				path: "/platform/pages/*",
				component: SiteBuilderEditorPage,
			},
			{
				id: "site-builder.layout-editor",
				path: "/platform/layouts/*",
				component: SiteBuilderEditorPage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [siteBuilderPanelPlugin];
