import { ComponentIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { ComponentsCatalogPage } from "./catalog-page.tsx";
import { BUILDER_BLOCKS_ELEMENT_KINDS_LIVE } from "./element-kinds.ts";
import { BUILDER_BLOCK_KINDS } from "./kinds.tsx";

/**
 * Builder-blocks plugin (P-108 / PL-013): the core site-builder
 * primitives — layout (section, container, columns, divider, spacer),
 * content (heading, cta) and data (metric, table) — contributed as
 * `elementKinds` so builder palettes (PL-014) and the
 * /platform/components catalog compose them from the registry.
 * `rich-text` and `image` are intentionally absent: owned by
 * plugins/rich-text and plugins/image.
 */

/**
 * Services contribution: registers every block kind's server
 * descriptor into the shared `ElementKinds` registry. Blocks are
 * self-contained — `resolve` is the identity function (the stored ref
 * IS the props payload), so no sibling services are needed; the layer
 * consumes `ElementKinds` optionally and builds fine without it.
 */
export const builderBlocksServicesPlugin = definePlugin({
	id: "builder-blocks.services",
	meta: { keywords: ["site", "services"] },
	services: BUILDER_BLOCKS_ELEMENT_KINDS_LIVE,
});

/**
 * Chrome contribution: the /platform/components catalog sidebar entry
 * (Site group).
 */
export const builderBlocksChromePlugin = definePlugin({
	id: "builder-blocks.chrome",
	meta: { keywords: ["site", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "builder-blocks.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/components",
					label: "Components",
					icon: ComponentIcon,
					group: "Site",
				},
			},
		},
	],
});

/**
 * Panel (system console) contribution: /platform/components is the
 * read-only element-kind catalog. The loader echoes nothing — kinds
 * are client-manifest data the component collects from `ctx.plugins`;
 * the `guard` hard-404s non-admins, same contract as the other
 * /platform pages.
 */
export const builderBlocksPanelPlugin = definePlugin({
	id: "builder-blocks.panel",
	meta: { keywords: ["site", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "builder-blocks.catalog",
				path: "/platform/components",
				component: ComponentsCatalogPage,
				// Path arg unused — the catalog is exact-path — but the
				// kernel signature passes the request path.
				loader: (_path: string) => Effect.succeed(null),
			}),
		],
	},
});

/**
 * Element-kind contribution (P-108): the nine core builder blocks.
 * `fields` carries each kind's prop schema (@ktb/json-schema subset)
 * for palette compilation and catalog docs; `editor` is the shared
 * schema-driven editor bound per kind. Server descriptors register via
 * `BUILDER_BLOCKS_ELEMENT_KINDS_LIVE` in builder-blocks.services.
 */
export const builderBlocksElementsPlugin = definePlugin({
	id: "builder-blocks.elements",
	meta: { keywords: ["site", "ui"] },
	elementKinds: BUILDER_BLOCK_KINDS,
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	builderBlocksServicesPlugin,
	builderBlocksChromePlugin,
	builderBlocksPanelPlugin,
	builderBlocksElementsPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"builder-blocks.services": true;
		"builder-blocks.chrome": true;
		"builder-blocks.panel": true;
		"builder-blocks.elements": true;
	}
}
