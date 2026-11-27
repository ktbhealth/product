import { BracesIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { SchemasAdminConsolePage } from "./platform-page.tsx";
import { schemas } from "./schema.ts";
import { Schemas, SchemasLive } from "./service.ts";

/**
 * Schemas plugin: admin-authored JSON Schemas (draft-2020-12 subset,
 * `@ktb/json-schema`) stored in the `schemas` table. The console lives
 * at /platform/schemas (panel contribution); `Schemas.getById` and
 * `Schemas.validate` are the public reads other plugins (e.g. the
 * pages plugin validating search params) use — every admin method
 * re-checks PlatformAdmin inside the service.
 */

export const schemasTablesPlugin = definePlugin({
	id: "schemas.tables",
	meta: { keywords: ["schemas", "tables"] },
	tables: { schemas },
});

export const schemasServicesPlugin = definePlugin({
	id: "schemas.services",
	meta: { keywords: ["schemas", "services"] },
	// adminList/adminGet/adminCreate/adminUpdate/adminRemove consume the
	// PlatformAdmin gate — the dep edge keeps the platform module
	// ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	services: SchemasLive,
});

/**
 * Chrome contribution: the /platform/schemas console sidebar entry
 * (Site group).
 */
export const schemasChromePlugin = definePlugin({
	id: "schemas.chrome",
	meta: { keywords: ["schemas", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "schemas.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/schemas",
					label: "Schemas",
					icon: BracesIcon,
					group: "Site",
				},
			},
		},
	],
});

/**
 * Panel (system console) contribution: /platform/schemas is the admin
 * CRUD surface. The loader returns every row's meta with an ISO
 * `updatedAt` (Date doesn't round-trip cleanly through loader data);
 * the service re-checks the admin gate. `guard` hard-404s non-admins —
 * same contract as the /platform layout gate.
 */
export const schemasPanelPlugin = definePlugin({
	id: "schemas.panel",
	meta: { keywords: ["schemas", "ui"] },
	requiredDeps: [platformPanelPlugin.id, schemasServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "schemas.admin",
				path: "/platform/schemas",
				component: SchemasAdminConsolePage,
				// Path arg unused — the admin page is exact-path — but the
				// kernel signature passes the request path.
				loader: (_path) =>
					Effect.gen(function* () {
						const schemas = yield* Schemas;
						const rows = yield* schemas
							.adminList()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])));
						return rows.map((row) => ({
							id: row.id,
							name: row.name,
							description: row.description,
							updatedAt: row.updatedAt.toISOString(),
						}));
					}),
			}),
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	schemasTablesPlugin,
	schemasServicesPlugin,
	schemasChromePlugin,
	schemasPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"schemas.tables": true;
		"schemas.services": true;
		"schemas.chrome": true;
		"schemas.panel": true;
	}
}
