import { definePlugin, type Plugin } from "@ktb/kernel";

import { NotFoundPageBoundary } from "./boundary.tsx";

/**
 * Not-found-page plugin (server manifest): the replaceable router
 * `notFound` boundary — a localized 404 surface whose call-to-action row
 * renders the host-collected `app.notFound.actions` chrome nodes, so it
 * never hardcodes feature links. Mirrors ./client.ts (the
 * client-discovery manifest); parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const notFoundPagePlugin = definePlugin({
	id: "not-found-page.boundary",
	meta: { keywords: ["site", "ui", "shell"] },
	boundaries: [{ kind: "notFound", component: NotFoundPageBoundary }],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [notFoundPagePlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"not-found-page.boundary": true;
	}
}
