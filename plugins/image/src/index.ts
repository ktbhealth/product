import { ImageIcon } from "lucide-react";
import { physical } from "@tanstack/virtual-file-routes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { ImageAdminConsolePage } from "./platform-page.tsx";
import { images } from "./schema.ts";
import { ImageDeleteHooksLive } from "./delete-hooks.ts";
import { ImageElementKindLive } from "./element-kind.ts";
import { imageElement } from "./kind.tsx";
import { Images, ImagesLive, type ImageRecord } from "./service.ts";

/**
 * Image plugin (P-111): the media library for site content — an
 * `images` table whose bytes live in the deployment's image object
 * store (R2 prod / filesystem stand-in dev:node), served publicly
 * through `/api/images/:id`, plus the `"image"` element kind builder
 * blocks and rich-text embeds reference. The console lives at
 * /platform/images (panel contribution); `Images.getById` is the
 * public read the element-kind descriptor and the serve route use —
 * every admin method re-checks PlatformAdmin inside the service.
 */

/** Wire shape the panel loader hands the console page — same fields
 * as `ImageWire` in ./fns.ts (kept local so index.ts stays free of
 * server-fn imports). */
const toLoaderRow = (row: ImageRecord) => ({
	id: row.id,
	title: row.title,
	alt: row.alt,
	mime: row.mime,
	size: row.size,
	width: row.width,
	height: row.height,
	createdAt: row.createdAt.toISOString(),
	src: `/api/images/${row.id}`,
});

export const imageTablesPlugin = definePlugin({
	id: "image.tables",
	meta: { keywords: ["image", "tables"] },
	tables: { images },
});

export const imageServicesPlugin = definePlugin({
	id: "image.services",
	meta: { keywords: ["image", "services"] },
	// adminList/adminGet/adminCreate/adminUpdate/adminRemove consume the
	// PlatformAdmin gate — the dep edge keeps the platform module
	// ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	// ImageElementKindLive registers the "image" descriptor into the
	// shared ElementKinds registry at build time; provideMerge wires
	// the sibling Images/ImageDeleteHooks services it resolves refs
	// and lifecycle hooks through (merge alone does NOT feed siblings
	// into each other's requirements).
	services: ImageElementKindLive.pipe(
		Layer.provideMerge(Layer.merge(ImagesLive, ImageDeleteHooksLive)),
	),
});

/**
 * Chrome contribution: the /platform/images console sidebar entry
 * (Site group).
 */
export const imageChromePlugin = definePlugin({
	id: "image.chrome",
	meta: { keywords: ["image", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
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

/**
 * Panel (system console) contribution: /platform/images is the admin
 * media library. The loader returns every row's meta (ISO
 * `createdAt`); the service re-checks the admin gate. `guard`
 * hard-404s non-admins — same contract as the /platform layout gate.
 */
export const imagePanelPlugin = definePlugin({
	id: "image.panel",
	meta: { keywords: ["image", "ui"] },
	requiredDeps: [platformPanelPlugin.id, imageServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "image.admin",
				path: "/platform/images",
				component: ImageAdminConsolePage,
				// Path arg unused — the admin page is exact-path — but the
				// kernel signature passes the request path.
				loader: (_path) =>
					Effect.gen(function* () {
						const images = yield* Images;
						const rows = yield* images
							.adminList()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
						return rows.map(toLoaderRow);
					}),
			}),
		],
	},
});

/**
 * Element-kind contribution (P-111): `"image"` is a citizen of the
 * managed-content registry — `ImageView` renders the resolved payload
 * (public serve URL + intrinsic metadata), `ImageElementEditor` is the
 * library-picker dialog. The kind is declared once in ./kind.tsx via
 * `defineElementKind`: this manifest entry IS `imageElement.manifest`
 * — the same object ./client.ts carries — and the server half
 * (resolve/hooks) registers via `ImageElementKindLive` in
 * image.services. Consumers never import this plugin's internals, they
 * go through `ElementKinds`.
 */
export const imageElementsPlugin = definePlugin({
	id: "image.elements",
	meta: { keywords: ["image", "ui"] },
	elementKinds: [imageElement.manifest],
});

/**
 * API routes (P-111): POST /api/images (admin upload) and
 * GET /api/images/$id (public serve) live in this package's
 * src/api-routes/ and mount under the shared "/api" prefix via a
 * physical() scan — same convention as theme.routes. The host's
 * routes.ts must list this plugin for the subtree to mount.
 */
export const imageRoutesPlugin = definePlugin({
	id: "image.routes",
	meta: { keywords: ["image", "routes"] },
	requiredDeps: [imageServicesPlugin.id],
	routes: [physical("/api", "../../../../plugins/image/src/api-routes")],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	imageTablesPlugin,
	imageServicesPlugin,
	imageChromePlugin,
	imagePanelPlugin,
	imageElementsPlugin,
	imageRoutesPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"image.tables": true;
		"image.services": true;
		"image.chrome": true;
		"image.panel": true;
		"image.elements": true;
		"image.routes": true;
	}
}
