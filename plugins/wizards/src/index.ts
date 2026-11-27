import { WandSparklesIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import type { Json } from "effect/Schema";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, adminConsolePage } from "@ktb/platform";
import { rbacServicesPlugin } from "@ktb/rbac-plugin";

import type { WizardDefWire } from "./fns.ts";
import { WizardsAdminConsolePage } from "./platform-page.tsx";
import { wizardDefs, wizardRuns } from "./schema.ts";
import { Wizards, WizardsServicesLive, type WizardDefAdminRow } from "./service.ts";
import { WizardRunner } from "./views/WizardRunner.tsx";

/**
 * Wizards plugin: admin-authored (`wizard_defs` table) and
 * code-contributed (`wizard.def` manifest entries) step wizards with
 * a pure interpreter, per-user runs (`wizard_runs`), completion
 * targets (document-store writes + the WizardHooks registry) and a
 * `/wizards/<id>` runner page.
 *
 * Plugin ids follow the `<pkg>.<concern>` convention; each object
 * carries exactly one contribution kind (kernel contract).
 */

export * from "./completion.ts";
export * from "./condition.ts";
export * from "./definition.ts";
export * from "./hooks.ts";
export * from "./i18n.ts";
export * from "./resolve.ts";
export * from "./schema.ts";
export * from "./service.ts";
export { WizardRunner } from "./views/WizardRunner.tsx";
export { WizardsAdminPage } from "./views/WizardsAdminPage.tsx";

const toWire = (row: WizardDefAdminRow): WizardDefWire => ({
	key: row.key,
	title: row.title,
	description: row.description,
	definition: row.definition as unknown as Json,
	published: row.published,
	updatedAt: row.updatedAt.toISOString(),
});

/** Drizzle table slice: wizard_defs + wizard_runs. */
export const wizardsTablesPlugin = definePlugin({
	id: "wizards.tables",
	meta: { keywords: ["wizards", "tables"] },
	tables: { wizardDefs, wizardRuns },
});

/**
 * Wizards + WizardHooks services. `WizardsServicesLive` merges the run
 * service with the hook registry OTHER plugins register completion
 * handlers on — depend on `wizards.services` to order after it.
 * PlatformAdmin is a core infra service (always bound); the dep edge
 * keeps the platform module ordered/discovered like pages.services.
 * `rbac.services` is an OPTIONAL dep purely for ordering: when the
 * rbac plugin is enabled its `Permissions` port is bound before this
 * layer builds, so `permission` gates resolve; when absent they fail
 * closed (see ./service.ts).
 */
export const wizardsServicesPlugin = definePlugin({
	id: "wizards.services",
	meta: { keywords: ["wizards", "services"] },
	requiredDeps: [platformAdminPlugin.id],
	optionalDeps: [rbacServicesPlugin.id],
	services: WizardsServicesLive,
});

/**
 * Console chrome: the /platform/wizards sidebar entry (Presentation group).
 */
export const wizardsChromePlugin = definePlugin({
	id: "wizards.chrome",
	meta: { keywords: ["wizards", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "wizards.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/wizards",
					label: "Wizards",
					icon: WandSparklesIcon,
					group: "Presentation",
				},
			},
		},
	],
});

/**
 * App-shell runner: `/wizards/<id>` resolves contributed + published
 * DB definitions client-side (defs are JSON data on the client
 * registry — same pattern as /forms/<id>) and drives the run through
 * the session-gated server fns. The loader echoes the request path;
 * the component derives the id. No guard: unknown ids render the
 * localized not-found state.
 */
export const wizardsRenderPlugin = definePlugin({
	id: "wizards.render",
	meta: { keywords: ["wizards", "ui"] },
	requiredDeps: [wizardsServicesPlugin.id],
	pages: [
		{
			id: "wizards.runner",
			path: "/wizards/*",
			context: "app",
			component: WizardRunner,
			loader: (path) => Effect.succeed(path),
		},
	],
});

/**
 * Panel (system console) contribution: /platform/wizards is the admin
 * surface — list + JSON editor + publish toggle over `wizard_defs`.
 * `guard` hard-404s non-admins; every `Wizards.admin*` method re-checks
 * the gate inside the service (defense in depth).
 */
export const wizardsPanelPlugin = definePlugin({
	id: "wizards.panel",
	meta: { keywords: ["wizards", "ui"] },
	requiredDeps: [platformPanelPlugin.id, wizardsServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "wizards.admin",
				path: "/platform/wizards",
				component: WizardsAdminConsolePage,
				// Path arg unused — the admin page is exact-path — but the
				// kernel signature passes the request path.
				loader: (_path) =>
					Effect.gen(function* () {
						const wizards = yield* Wizards;
						return (yield* wizards
							.adminList()
							.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([])))).map(toWire);
					}),
			}),
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	wizardsTablesPlugin,
	wizardsServicesPlugin,
	wizardsChromePlugin,
	wizardsRenderPlugin,
	wizardsPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"wizards.tables": true;
		"wizards.services": true;
		"wizards.chrome": true;
		"wizards.render": true;
		"wizards.panel": true;
	}
}
