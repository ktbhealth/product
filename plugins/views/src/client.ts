import { definePlugin, type Plugin } from "@ktb/kernel";

import { ViewPage } from "./views/ViewPage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contribution is carried: the `/v/*` page descriptor (id/path/
 * component/context — the loader/guard Effects stay server-side in
 * ./index.ts). Dep ids are literals: importing ./index.ts would pull
 * the server graph (DocumentStore, services, Layers) into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 *
 * `view.def` contributions are NOT mirrored here: they belong to the
 * CONTRIBUTING plugins' manifests. Each emitter must mirror its
 * `viewDefContribution(...)` entries in its own client.ts (same
 * contract as form.def/wizard.def) — ViewPage resolves defs from
 * `ctx.plugins` (the enabled-filtered client registry) and matches
 * them to wire payloads by mount path.
 */
export const viewsPagesPlugin = definePlugin({
	id: "views.pages",
	meta: { keywords: ["views", "ui"] },
	requiredDeps: ["views.services"],
	pages: [
		{
			id: "views.page",
			path: "/v/*",
			context: "app",
			component: ViewPage,
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). Mirrors
 * viewsServicesPlugin (server index.ts) minus its server-only slice —
 * services never reach the client bundle, but the id must exist so
 * dep edges and enabled-state filtering line up with the server
 * registry. */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "views.services",
		meta: { keywords: ["views", "services"] },
		requiredDeps: ["document-store.services"],
	}),
	viewsPagesPlugin,
];
