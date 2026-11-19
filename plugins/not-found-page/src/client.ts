import { definePlugin, type Plugin } from "@ktb/kernel";

import { NotFoundPageBoundary } from "./boundary.tsx";

/**
 * Client-safe plugin entry — discovered by the browser bundle through
 * `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Single contribution: the replaceable
 * router `notFound` boundary (404 page). Actions come from the host via
 * the `app.notFound.actions` chrome region, so no feature links are
 * hardcoded here. No server-side contributions, so ./index.ts keeps an
 * explicit copy for parity — asserted by apps/web/src/plugins.test.ts.
 */
export const notFoundPagePlugin = definePlugin({
	id: "not-found-page.boundary",
	meta: { keywords: ["site", "ui", "shell"] },
	boundaries: [{ kind: "notFound", component: NotFoundPageBoundary }],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [notFoundPagePlugin];
