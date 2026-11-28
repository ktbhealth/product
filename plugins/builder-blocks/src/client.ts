import { ComponentIcon } from "lucide-react";

import { clientStub, definePlugin, type Plugin } from "@ktb/kernel";

import { ComponentsCatalogPage } from "./catalog-page.tsx";
import { BUILDER_BLOCK_KINDS } from "./kinds.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the chrome entry, the panel page
 * descriptor (component only — the guard/loader Effects stay
 * server-side in ./index.ts) and the elementKinds manifest (P-108 —
 * the server descriptors register via BUILDER_BLOCKS_ELEMENT_KINDS_LIVE
 * in the services layer, never mirrored here). Dep ids are literals:
 * importing ./index.ts would pull the server graph into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const builderBlocksChromePlugin = definePlugin({
	i18nKeys: {
		groups: { Site: "panel_group_site" },
	},
	id: "builder-blocks.chrome",
	meta: { keywords: ["site", "ui"] },
	requiredDeps: ["platform.panel"],
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

export const builderBlocksPanelPlugin = definePlugin({
	id: "builder-blocks.panel",
	meta: { keywords: ["site", "ui"] },
	requiredDeps: ["platform.panel"],
	panel: {
		pages: [
			{
				id: "builder-blocks.catalog",
				path: "/platform/components",
				component: ComponentsCatalogPage,
			},
		],
	},
});

/** Element-kind manifest (P-108): mirrors builderBlocksElementsPlugin
 * in ./index.ts — same BUILDER_BLOCK_KINDS entries (kind/label/
 * description/category/icon/fields/renderer/editor all come from the
 * shared ./kinds.tsx module, so parity is structural). The server
 * descriptors register via BUILDER_BLOCKS_ELEMENT_KINDS_LIVE — never
 * mirrored here. */
export const builderBlocksElementsPlugin = definePlugin({
	id: "builder-blocks.elements",
	meta: { keywords: ["site", "ui"] },
	elementKinds: BUILDER_BLOCK_KINDS,
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). Mirrors
 * builderBlocksServicesPlugin (server index.ts) minus its server-only
 * services slice — the id must exist so dep edges and enabled-state
 * filtering line up with the server registry. */
export const plugins: readonly Plugin[] = [
	clientStub({
		id: "builder-blocks.services",
		meta: { keywords: ["site", "services"] },
	}),
	builderBlocksChromePlugin,
	builderBlocksPanelPlugin,
	builderBlocksElementsPlugin,
];
