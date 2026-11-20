import { LayoutTemplateIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import { richTextServicesPlugin } from "@ktb/rich-text";
import { templatesServicesPlugin } from "@ktb/templates";

import { LayoutsAdminConsolePage } from "./platform-page.tsx";
import { layouts } from "./schema.ts";
import { Layouts, LayoutsLive } from "./service.ts";
import { LayoutsTemplateKindLive } from "./template-kind.ts";

/**
 * Layouts plugin: admin-authored page-body layouts stored in the
 * `layouts` table — ordered named sections, each binding a content
 * slot (today only `kind: "rich-text"` referencing `rich_text`
 * documents). The console lives at /platform/layouts (panel
 * contribution); `Layouts.getById`/`resolveForPage` are the public
 * reads other plugins (the pages plugin rendering
 * `pages.layout_id`) use — every admin method re-checks
 * PlatformAdmin inside the service.
 */

export const layoutsTablesPlugin = definePlugin({
	id: "layouts.tables",
	meta: { keywords: ["layouts", "tables"] },
	tables: { layouts },
});

export const layoutsServicesPlugin = definePlugin({
	id: "layouts.services",
	meta: { keywords: ["layouts", "services"] },
	// adminList/adminGet/adminCreate/adminUpdate/adminRemove consume the
	// PlatformAdmin gate — the dep edge keeps the platform module
	// ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	// Optional edge: slots resolve through @ktb/rich-text documents and
	// the delete-hook registry lives in its service layer — absent it,
	// resolveForPage skips every slot and no hook is registered
	// (Effect.serviceOption), but ordering must put the registry before
	// this layer when both are installed. Same contract for the
	// "layout" template kind: LayoutsTemplateKindLive registers into
	// the shared TemplateKinds registry via serviceOption — absent
	// templates.services it registers nothing.
	optionalDeps: [richTextServicesPlugin.id, templatesServicesPlugin.id],
	services: Layer.merge(LayoutsLive, LayoutsTemplateKindLive),
});

/**
 * Chrome contribution: the /platform/layouts console sidebar entry
 * (Site group) plus the rich-text delete dialog actions (region owned
 * by @ktb/rich-text): offered when the document being deleted is
 * referenced by layout slots. `action.id`/`owner` are the contract the
 * layouts delete hook's cleanup switch keys on — keep them exact.
 */
export const layoutsChromePlugin = definePlugin({
	id: "layouts.chrome",
	meta: { keywords: ["layouts", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "layouts.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/layouts",
					label: "Layouts",
					icon: LayoutTemplateIcon,
					group: "Site",
				},
			},
		},
		{
			id: "layouts.delete-action-unlink",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "layouts.unlink-slots",
					owner: "layouts",
					label: "Empty layout slots",
					description:
						"Layouts keep their settings but the slots using this document render empty.",
					destructive: false,
				},
			},
		},
		{
			id: "layouts.delete-action-delete",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "layouts.delete-layouts",
					owner: "layouts",
					label: "Delete layouts too",
					description: "Permanently deletes every layout using this document.",
					destructive: true,
				},
			},
		},
	],
});

/**
 * Panel (system console) contribution: /platform/layouts is the admin
 * CRUD surface. The loader returns every row's meta (with an ISO
 * `updatedAt` — Date doesn't round-trip cleanly through loader data)
 * plus the section count; the service re-checks the admin gate.
 * `guard` hard-404s non-admins — same contract as the /platform
 * layout gate.
 */
export const layoutsPanelPlugin = definePlugin({
	id: "layouts.panel",
	meta: { keywords: ["layouts", "ui"] },
	requiredDeps: [platformPanelPlugin.id, layoutsServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "layouts.admin",
				path: "/platform/layouts",
				component: LayoutsAdminConsolePage,
				// Path arg unused — the admin page is exact-path — but the
				// kernel signature passes the request path.
				guard: (_path) =>
					Effect.gen(function* () {
						const platformAdmin = yield* PlatformAdmin;
						return yield* platformAdmin.requireAdmin().pipe(
							Effect.as(true),
							Effect.catchTag("Forbidden", () => Effect.succeed(false)),
						);
					}),
				loader: (_path) =>
					Effect.gen(function* () {
						const layoutsService = yield* Layouts;
						const rows = yield* layoutsService
							.adminList()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
						return rows.map((row) => ({
							id: row.id,
							name: row.name,
							description: row.description,
							sectionCount: row.sectionCount,
							updatedAt: row.updatedAt.toISOString(),
						}));
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	layoutsTablesPlugin,
	layoutsServicesPlugin,
	layoutsChromePlugin,
	layoutsPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"layouts.tables": true;
		"layouts.services": true;
		"layouts.chrome": true;
		"layouts.panel": true;
	}
}
