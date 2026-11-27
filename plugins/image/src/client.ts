import { ImageIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { ImageAdminConsolePage } from "./platform-page.tsx";
import { ImageView } from "./views/ImageView.tsx";
import { ImageElementEditor } from "./views/ImageElementEditor.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the chrome entry, the panel page
 * descriptor (component only — the guard/loader Effects stay
 * server-side in ./index.ts) and the elementKinds manifest. The
 * server descriptor registers via ImageElementKindLive in the
 * services layer, never mirrored here. Dep ids are literals: importing
 * ./index.ts would pull the server graph (Db, services, Layers) into
 * the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const imageChromePlugin = definePlugin({
	i18nKeys: {
		groups: { Site: "panel_group_site" },
	},
	id: "image.chrome",
	meta: { keywords: ["image", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "image.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/images",
					label: "Images",
					icon: ImageIcon,
					group: "Site",
				},
			},
		},
	],
});

export const imagePanelPlugin = definePlugin({
	id: "image.panel",
	meta: { keywords: ["image", "ui"] },
	requiredDeps: ["platform.panel", "image.services"],
	panel: {
		pages: [
			{
				id: "image.admin",
				path: "/platform/images",
				component: ImageAdminConsolePage,
			},
		],
	},
});

/** Element-kind manifest: mirrors imageElementsPlugin in ./index.ts —
 * same kind/label/icon and the same component references (ImageView is
 * a plain <img>; ImageElementEditor pulls the dialog/upload stack,
 * which the client bundle already carries via the admin console page).
 * The server descriptor registers via ImageElementKindLive — never
 * mirrored here. */
export const imageElementsPlugin = definePlugin({
	id: "image.elements",
	meta: { keywords: ["image", "ui"] },
	elementKinds: [
		{
			kind: "image",
			label: "Image",
			icon: ImageIcon,
			renderer: ImageView,
			editor: ImageElementEditor,
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	// Mirrors imageTablesPlugin/imageServicesPlugin/imageRoutesPlugin
	// (server index.ts) minus their server-only slices — tables/
	// services/routes never reach the client bundle, but the ids must
	// exist so dep edges and enabled-state filtering line up with the
	// server registry.
	definePlugin({ id: "image.tables", meta: { keywords: ["image", "tables"] } }),
	definePlugin({
		id: "image.services",
		meta: { keywords: ["image", "services"] },
		requiredDeps: ["platform.admin"],
	}),
	imageChromePlugin,
	imagePanelPlugin,
	imageElementsPlugin,
	definePlugin({
		id: "image.routes",
		meta: { keywords: ["image", "routes"] },
		requiredDeps: ["image.services"],
	}),
];
