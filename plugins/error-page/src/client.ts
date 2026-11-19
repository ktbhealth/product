import { definePlugin, type Plugin } from "@ktb/kernel";

import { ErrorPageBoundary } from "./boundary.tsx";

/**
 * Client-safe plugin entry — discovered by the browser bundle through
 * `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Single contribution: the replaceable
 * `error` router boundary. Boundaries are client-rendered surfaces, so
 * this module IS the whole plugin; ./index.ts re-exports the same
 * definition for server-side discovery. Keep in sync — parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const errorPageBoundaryPlugin = definePlugin({
	id: "error-page.boundary",
	meta: { keywords: ["ui", "shell"] },
	boundaries: [{ kind: "error", component: ErrorPageBoundary }],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [errorPageBoundaryPlugin];

export { ErrorPageBoundary } from "./boundary.tsx";
export { ERROR_PAGE_LOCALES, I18N_NAMESPACE, errorPageMessages, i18nMessagesFor } from "./i18n.ts";
export type { ErrorPageLocale, ErrorPageMessages } from "./i18n.ts";
