import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { layoutsServicesPlugin } from "@ktb/layouts";
import { Layouts } from "@ktb/layouts/service";
import { pagesServicesPlugin } from "@ktb/pages";
import { Pages } from "@ktb/pages/service";
import { platformAdminGuard, platformPanelPlugin } from "@ktb/platform";
import { routeContribution } from "@ktb/platform/routes";

import { SiteBuilderEditorPage } from "./editor-lazy.tsx";
import type { BuilderDocumentWire, BuilderTargetKind } from "./fns.ts";

/**
 * Site-builder plugin (PL-014 / P-109): the thin Puck host. It owns no
 * tables — `pages.builder_json`/`layouts.builder_json` belong to the
 * pages/layouts plugins, which expose `adminGet`/`adminSetBuilderJson`
 * as the read/write seam. This plugin contributes:
 *
 * - two wildcard panel pages — `/platform/pages/*` and
 *   `/platform/layouts/*` — whose loaders parse `<id>/edit` suffixes
 *   and feed the entity's stored `builderJson` to the Puck editor;
 * - route-registry defs for the concrete edit paths so console links
 *   resolve through `Routes.route()`.
 *
 * Rendering is NOT here: `PageView` (pages) and the layout resolver
 * read `builderJson` through `@ktb/builder`'s `<Render>` adapter —
 * the same `toPuckConfig(elementKinds)` compilation this editor uses,
 * so canvas and published output share components.
 */

/** `/platform/pages/<id>/edit` — digits only; anything else under the
 * wildcard is not an editor path (guard 404s). */
const PAGE_EDIT_RE = /^\/platform\/pages\/(\d+)\/edit\/?$/;
const LAYOUT_EDIT_RE = /^\/platform\/layouts\/(\d+)\/edit\/?$/;

interface EditTarget {
	readonly kind: BuilderTargetKind;
	readonly id: number;
}

const parseEditPath = (path: string): EditTarget | null => {
	const page = PAGE_EDIT_RE.exec(path);
	if (page !== null) return { kind: "page", id: Number(page[1]) };
	const layout = LAYOUT_EDIT_RE.exec(path);
	if (layout !== null) return { kind: "layout", id: Number(layout[1]) };
	return null;
};

/** Resolve the wildcard path to the entity's builder document. Both
 * services are optional edges: a host without pages/layouts (or with
 * them disabled) resolves null → guard 404s / loader yields null. */
const fetchDocument = (path: string): Effect.Effect<BuilderDocumentWire | null, unknown> =>
	Effect.gen(function* () {
		const target = parseEditPath(path);
		if (target === null) return null;
		if (target.kind === "page") {
			const pages = yield* Effect.serviceOption(Pages);
			if (Option.isNone(pages)) return null;
			const row = yield* pages.value.adminGet(target.id);
			if (row === null) return null;
			return {
				kind: "page" as const,
				id: row.id,
				title: row.title,
				subtitle: row.path,
				builderJson: row.builderJson,
			};
		}
		const layouts = yield* Effect.serviceOption(Layouts);
		if (Option.isNone(layouts)) return null;
		const doc = yield* layouts.value.adminGet(target.id);
		if (doc === null) return null;
		return {
			kind: "layout" as const,
			id: doc.id,
			title: doc.name,
			subtitle: doc.description,
			builderJson: doc.builderJson,
		};
	});

/** Shared guard: valid edit path + admin + the entity exists. */
const editorGuard = (path: string) =>
	Effect.gen(function* () {
		if (parseEditPath(path) === null) return false;
		if (!(yield* platformAdminGuard())) return false;
		const doc = yield* fetchDocument(path);
		return doc !== null;
	});

/** Panel (system console) contribution: the two editor wildcards.
 * `guard`/`loader` receive the concrete request path — the wildcard
 * descriptor resolves which entity `<id>/edit` names. */
export const siteBuilderPanelPlugin = definePlugin({
	id: "site-builder.panel",
	meta: { keywords: ["site", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	// Optional edges: the editor reads/writes through the pages and
	// layouts services — absent either, that target's paths 404 via
	// `Effect.serviceOption` degradation instead of failing the layer.
	optionalDeps: [pagesServicesPlugin.id, layoutsServicesPlugin.id],
	// Route-registry defs (PL-011): the concrete `:id/edit` paths —
	// the wildcard descriptors above can't be `Routes.route()`d.
	contributions: [
		routeContribution("site-builder.page.edit", {
			path: "/platform/pages/:id/edit",
			params: ["id"],
			portal: "platform",
		}),
		routeContribution("site-builder.layout.edit", {
			path: "/platform/layouts/:id/edit",
			params: ["id"],
			portal: "platform",
		}),
	],
	panel: {
		pages: [
			{
				id: "site-builder.page-editor",
				path: "/platform/pages/*",
				component: SiteBuilderEditorPage,
				guard: editorGuard,
				loader: (path) => fetchDocument(path),
			},
			{
				id: "site-builder.layout-editor",
				path: "/platform/layouts/*",
				component: SiteBuilderEditorPage,
				guard: editorGuard,
				loader: (path) => fetchDocument(path),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [siteBuilderPanelPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"site-builder.panel": true;
	}
}

// Route-registry keys (PL-011): the path literal must match the
// `routeContribution` meta above — `Routes.route()` types params off it.
declare module "@ktb/platform/routes" {
	interface RouteRegistry {
		"site-builder.page.edit": "/platform/pages/:id/edit";
		"site-builder.layout.edit": "/platform/layouts/:id/edit";
	}
}
