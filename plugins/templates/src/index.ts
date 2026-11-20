import { BookTemplateIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";

import { TemplateKinds, TemplateKindsLive } from "./kinds.ts";
import { TemplatesAdminConsolePage } from "./platform-page.tsx";
import { templates } from "./schema.ts";
import { Templates, TemplatesLive } from "./service.ts";

/**
 * Templates plugin: the platform save-as-template capability (P-107).
 * The `templates` table stores `{ kind, name, description, payload }`
 * snapshots; kind owners (layouts today) register a `TemplateKind`
 * descriptor — serialize/deserialize/validate/preview — into the
 * `TemplateKinds` registry at layer build. The console lives at
 * /platform/templates (panel contribution); `Templates.getById` is the
 * public read — every admin method re-checks PlatformAdmin inside the
 * service, and `Templates.instantiate` only deserializes (the owning
 * plugin's own create path does the writing).
 */

export const templatesTablesPlugin = definePlugin({
	id: "templates.tables",
	meta: { keywords: ["templates", "tables"] },
	tables: { templates },
});

export const templatesServicesPlugin = definePlugin({
	id: "templates.services",
	meta: { keywords: ["templates", "services"] },
	// adminList/listByKind/adminGet/save/adminUpdate/adminRemove/
	// instantiate consume the PlatformAdmin gate — the dep edge keeps
	// the platform module ordered (and discovered) before this
	// plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	// provideMerge wires the shared TemplateKinds registry into
	// TemplatesLive's requirements AND retains it in the layer output —
	// kind owners (layouts.services via optionalDeps) register their
	// descriptors into this same instance through serviceOption.
	services: TemplatesLive.pipe(Layer.provideMerge(TemplateKindsLive)),
});

/**
 * Chrome contribution: the /platform/templates console sidebar entry
 * (Site group).
 */
export const templatesChromePlugin = definePlugin({
	id: "templates.chrome",
	meta: { keywords: ["templates", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "templates.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/templates",
					label: "Templates",
					icon: BookTemplateIcon,
					group: "Site",
				},
			},
		},
	],
});

/**
 * Panel (system console) contribution: /platform/templates is the admin
 * CRUD surface. The loader returns every row's meta (with an ISO
 * `updatedAt` — Date doesn't round-trip cleanly through loader data)
 * plus the registered kind ids/labels for grouping; the service
 * re-checks the admin gate. `guard` hard-404s non-admins — same
 * contract as the /platform layout gate.
 */
export const templatesPanelPlugin = definePlugin({
	id: "templates.panel",
	meta: { keywords: ["templates", "ui"] },
	requiredDeps: [platformPanelPlugin.id, templatesServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "templates.admin",
				path: "/platform/templates",
				component: TemplatesAdminConsolePage,
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
						const templatesService = yield* Templates;
						const kinds = yield* TemplateKinds;
						const [rows, registered] = yield* Effect.all([
							templatesService
								.adminList()
								.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([]))),
							Effect.succeed(kinds.list().map((kind) => ({ kind: kind.kind, label: kind.label }))),
						]);
						return {
							rows: rows.map((row) => ({
								id: row.id,
								kind: row.kind,
								name: row.name,
								description: row.description,
								createdBy: row.createdBy,
								createdAt: row.createdAt.toISOString(),
								updatedAt: row.updatedAt.toISOString(),
							})),
							kinds: registered,
						};
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	templatesTablesPlugin,
	templatesServicesPlugin,
	templatesChromePlugin,
	templatesPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"templates.tables": true;
		"templates.services": true;
		"templates.chrome": true;
		"templates.panel": true;
	}
}
