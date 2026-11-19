import { definePlugin, type Plugin } from "@ktb/kernel";

import { ErrorPageBoundary } from "./boundary.tsx";

/**
 * Replaceable error boundary (boundaries-only plugin): contributes the
 * `error` router boundary the host selects in place of the built-in
 * RootError fallback. `BoundariesPlugin` forbids every other
 * contribution field — the surface's action links arrive pre-rendered
 * via the `app.error.actions` chrome region, so this plugin carries no
 * chrome/routes/pages of its own.
 */
export const errorPageBoundaryPlugin = definePlugin({
	id: "error-page.boundary",
	meta: { keywords: ["ui", "shell"] },
	boundaries: [{ kind: "error", component: ErrorPageBoundary }],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [errorPageBoundaryPlugin];

export { ErrorPageBoundary } from "./boundary.tsx";
export { ERROR_PAGE_LOCALES, I18N_NAMESPACE, errorPageMessages, i18nMessagesFor } from "./i18n.ts";
export type { ErrorPageLocale, ErrorPageMessages } from "./i18n.ts";

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"error-page.boundary": true;
	}
}
