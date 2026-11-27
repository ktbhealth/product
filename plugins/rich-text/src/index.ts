import { PenLineIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { RichTextAdminConsolePage } from "./platform-page.tsx";
import { richText } from "./schema.ts";
import { RichTextDeleteHooksLive } from "./delete-hooks.ts";
import { RichTextElementKindLive } from "./element-kind.ts";
import { RichTexts, RichTextsLive } from "./service.ts";
import { RichTextView } from "./views/RichTextView.tsx";
import { RichTextElementEditor } from "./views/RichTextElementEditor.tsx";

/**
 * Rich-text plugin: admin-authored documents stored in the `rich_text`
 * table and edited with the Plate-based `RichTextEditor`. The console
 * lives at /platform/rich-text (panel contribution); `RichTexts.getById`
 * is the public read other plugins (e.g. the pages doc picker) use to
 * embed stored content — every admin method re-checks PlatformAdmin
 * inside the service.
 */

export const richTextTablesPlugin = definePlugin({
	id: "rich-text.tables",
	meta: { keywords: ["rich-text", "tables"] },
	tables: { richText },
});

export const richTextServicesPlugin = definePlugin({
	id: "rich-text.services",
	meta: { keywords: ["rich-text", "services"] },
	// adminList/adminGet/adminCreate/adminUpdate/adminRemove consume the
	// PlatformAdmin gate — the dep edge keeps the platform module
	// ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	// RichTextElementKindLive registers the "rich-text" descriptor into
	// the shared ElementKinds registry at build time; provideMerge wires
	// the sibling RichTexts/RichTextDeleteHooks services it resolves
	// refs and lifecycle hooks through (merge alone does NOT feed
	// siblings into each other's requirements).
	services: RichTextElementKindLive.pipe(
		Layer.provideMerge(Layer.merge(RichTextsLive, RichTextDeleteHooksLive)),
	),
});

/**
 * Chrome contribution: the /platform/rich-text console sidebar entry
 * (Content group).
 */
export const richTextChromePlugin = definePlugin({
	id: "rich-text.chrome",
	meta: { keywords: ["rich-text", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "rich-text.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/rich-text",
					label: "Rich text",
					icon: PenLineIcon,
					group: "Site",
				},
			},
		},
	],
});

/**
 * Panel (system console) contribution: /platform/rich-text is the admin
 * CRUD surface. The loader returns every row's meta with an ISO
 * `updatedAt` (Date doesn't round-trip cleanly through loader data);
 * the service re-checks the admin gate. `guard` hard-404s non-admins —
 * same contract as the /platform layout gate.
 */
export const richTextPanelPlugin = definePlugin({
	id: "rich-text.panel",
	meta: { keywords: ["rich-text", "ui"] },
	requiredDeps: [platformPanelPlugin.id, richTextServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "rich-text.admin",
				path: "/platform/rich-text",
				component: RichTextAdminConsolePage,
				// Path arg unused — the admin page is exact-path — but the
				// kernel signature passes the request path.
				loader: (_path) =>
					Effect.gen(function* () {
						const richTexts = yield* RichTexts;
						const rows = yield* richTexts
							.adminList()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
						return rows.map((row) => ({
							id: row.id,
							title: row.title,
							updatedAt: row.updatedAt.toISOString(),
						}));
					}),
			}),
		],
	},
});

/**
 * Element-kind contribution (P-102): `"rich-text"` is the first
 * citizen of the managed-content registry — `RichTextView` renders
 * resolved payloads platejs-free, `RichTextElementEditor` adapts the
 * Plate editor to the kind's `{ value, onChange }` contract. The
 * server half (resolve/hooks) registers via `RichTextElementKindLive`
 * in rich-text.services — consumers never import this plugin's
 * internals, they go through `ElementKinds`.
 */
export const richTextElementsPlugin = definePlugin({
	id: "rich-text.elements",
	meta: { keywords: ["rich-text", "ui"] },
	elementKinds: [
		{
			kind: "rich-text",
			label: "Rich text",
			icon: PenLineIcon,
			renderer: RichTextView,
			editor: RichTextElementEditor,
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	richTextTablesPlugin,
	richTextServicesPlugin,
	richTextChromePlugin,
	richTextPanelPlugin,
	richTextElementsPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"rich-text.tables": true;
		"rich-text.services": true;
		"rich-text.chrome": true;
		"rich-text.panel": true;
		"rich-text.elements": true;
	}
}
