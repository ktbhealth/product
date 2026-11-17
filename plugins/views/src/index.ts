import * as Effect from "effect/Effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { documentStoreServicesPlugin } from "@ktb/document-store";

import { Views, ViewsLive } from "./service.ts";
import { ViewPage } from "./views/ViewPage.tsx";

/**
 * Views plugin: schema-driven read views. Plugins declare `view.def`
 * contributions (JSON meta — see ./definition.ts) over document-store
 * collections; the `/v/*` wildcard page resolves the def server-side,
 * checks the optional `resource.action` permission, queries
 * `DocumentStore` with the declared filters/sort/pagination and
 * renders table/cards/detail layouts with @ktbhealth/ui — no
 * per-collection UI code.
 *
 * Plugin ids follow the `<pkg>.<concern>` convention; each object
 * carries exactly one contribution kind (kernel contract).
 */

export * from "./definition.ts";
export * from "./i18n.ts";
export * from "./plan.ts";
export * from "./service.ts";
export * from "./wire.ts";
export { ViewPage } from "./views/ViewPage.tsx";
export { TableView } from "./views/TableView.tsx";
export { CardsView } from "./views/CardsView.tsx";
export { DetailView } from "./views/DetailView.tsx";
export { FilterBar } from "./views/FilterBar.tsx";

/**
 * Views service citizen: def resolution + record queries over
 * DocumentStore. Requires `ViewDefinitions` (provided by
 * @ktb/app-host's core layer, like `DocumentCollections`) and
 * `DocumentStore` — the dep edge on `document-store.services` keeps
 * the store layer ordered first. `Permissions` (@ktb/rbac) is an
 * OPTIONAL port consumed via `Effect.serviceOption`: defs without a
 * `permission` work with rbac disabled; permission'd defs fail
 * closed.
 */
export const viewsServicesPlugin = definePlugin({
	id: "views.services",
	meta: { keywords: ["views", "services"] },
	requiredDeps: [documentStoreServicesPlugin.id],
	services: ViewsLive,
});

/**
 * App-shell wildcard page: `/v/*` resolves `<viewKey>[/<docId>]` —
 * list mode on the bare key (table/cards kinds; a `detail` kind's
 * bare path renders its `fields` as a table index), detail mode when
 * a numeric doc id follows. The loader runs the full server-side
 * pipeline (def → permission → store query → wire payload); `guard`
 * hard-404s unknown keys and denied permissions before any record
 * fetch. Def `context: "portal"` is accepted by the schema but v1
 * dispatches every view through the app shell (portal instances are
 * a separate registry — see definition.ts).
 */
export const viewsPagesPlugin = definePlugin({
	id: "views.pages",
	meta: { keywords: ["views", "ui"] },
	requiredDeps: [viewsServicesPlugin.id],
	pages: [
		{
			id: "views.page",
			path: "/v/*",
			context: "app",
			component: ViewPage,
			guard: (path) =>
				Effect.gen(function* () {
					const views = yield* Views;
					return yield* views.allows(path);
				}),
			loader: (path) =>
				Effect.gen(function* () {
					const views = yield* Views;
					// guard already denied unknown/forbidden paths; a null
					// here means an unregistered collection raced in —
					// collapse to the same not-found the component renders.
					return yield* views.load(path);
				}),
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [viewsServicesPlugin, viewsPagesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"views.services": true;
		"views.pages": true;
	}
}
