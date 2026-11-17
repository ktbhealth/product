import { physical } from "@tanstack/virtual-file-routes";

import { documentStoreServicesPlugin } from "@ktb/document-store";
import { definePlugin, type Plugin } from "@ktb/kernel";

import { ApiLive } from "./service.ts";

export * from "./exposure.ts";
export * from "./http.ts";
export * from "./service.ts";

/**
 * Api plugin: turns opted-in document-store collections into HTTP
 * endpoints under `/api/documents/*`. Collections are NOT public by
 * default — plugins contribute `api.expose` defs (JSON meta, see
 * ./exposure.ts) naming the collection, an optional `basePath` alias,
 * an optional `"resource.action"` permission, a `methods` list
 * (default read-only) and a `public` flag for anonymous reads. Only
 * exposed collections get endpoints; everything else 404s.
 *
 * Plugin ids follow the `<pkg>.<concern>` convention; each object
 * carries exactly one contribution kind (kernel contract).
 */

/**
 * Api service citizen: exposure resolution + authz + DocumentStore
 * dispatch. Requires `DocumentStore` (dep edge on
 * `document-store.services` keeps the store layer ordered first) and
 * `ApiExposures` — provided by @ktb/app-host's core layer like
 * `DocumentCollections`/`ViewDefinitions`. `Permissions` (@ktb/rbac)
 * is an OPTIONAL port consumed via `Effect.serviceOption`: exposures
 * without a `permission` work with rbac disabled; permission'd
 * exposures fail closed.
 */
export const apiServicesPlugin = definePlugin({
	id: "api.services",
	meta: { keywords: ["api", "services"] },
	requiredDeps: [documentStoreServicesPlugin.id],
	services: ApiLive,
});

/**
 * HTTP route subtree: `physical("/api", "src/api-routes")` mounts the
 * directory scan under the shared "/api" prefix alongside the host's
 * own api directory and the other plugins' mounts. The directory path
 * is resolved relative to the host's routes directory
 * (apps/web/src/routes) — "../../../../" escapes to the repo root.
 * Route modules must live directly in src/api-routes/ — the generator
 * scans every .ts file there, so tests stay outside this directory.
 *
 * The splat `documents.$.ts` serves `/api/documents/<key>[/<id>]` for
 * every exposed collection; `documents.ts` answers the bare
 * `/api/documents` root with the same indistinguishable 404.
 */
export const apiRoutesPlugin = definePlugin({
	id: "api.routes",
	meta: { keywords: ["api", "routes"] },
	requiredDeps: [apiServicesPlugin.id],
	routes: [physical("/api", "../../../../plugins/api/src/api-routes")],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [apiServicesPlugin, apiRoutesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"api.services": true;
		"api.routes": true;
	}
}
