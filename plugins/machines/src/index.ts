import { ServerIcon } from "lucide-react";

import { Effect } from "effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { Machines, MachinesLive, type MachineCard } from "./machines.ts";
import { MachinesPanelPage } from "./platform-page.tsx";
import { machine } from "./schema.ts";

export { machine } from "./schema.ts";
export type { Machine, MachineKind, MachineStatus } from "./schema.ts";
export {
	MACHINE_STALE_MS,
	MachineError,
	Machines,
	MachinesLive,
	type MachineCard,
} from "./machines.ts";

export const machinesTablesPlugin = definePlugin({
	id: "machines.tables",
	meta: { keywords: ["machines", "tables"] },
	tables: { machine },
});

/**
 * Machine registry service (P-098 D1/D2): CRUD + heartbeat (`beat`) +
 * health probes (`check`/`checkAll`) over the `machine` table.
 * Registry only — ACP/shell/VM execution stays in consumer adapters;
 * `secretRef` is a `vault:<id>` pointer, never material. Audit
 * resolves via serviceOption — absence is legal.
 */
export const machinesServicesPlugin = definePlugin({
	id: "machines.services",
	meta: { keywords: ["machines", "services"] },
	optionalDeps: ["audit.services"],
	services: MachinesLive,
});

export const machinesChromePlugin = definePlugin({
	id: "machines.chrome",
	meta: { keywords: ["machines", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "machines.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/ai/machines",
					label: "Machines",
					icon: ServerIcon,
					group: "Runtime",
				},
			},
		},
	],
});

export const machinesPanelPlugin = definePlugin({
	id: "machines.panel",
	meta: { keywords: ["machines", "ui"] },
	requiredDeps: [platformPanelPlugin.id, machinesServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "machines",
				path: "/platform/ai/machines",
				component: MachinesPanelPage,
				loader: () =>
					Effect.gen(function* () {
						const machines = yield* Machines;
						return yield* machines.list({ scope: "platform" }).pipe(
							Effect.catchTags({
								/* v8 ignore next -- platform-scope list raises neither */
								MachineError: () => Effect.succeed([] as MachineCard[]),
								/* v8 ignore next -- platform-scope list raises neither */
								TenantForbidden: () => Effect.succeed([] as MachineCard[]),
								Forbidden: () => Effect.succeed([] as MachineCard[]),
							}),
						);
					}),
			}),
		],
	},
});

// Re-exported for tests: DDL that creates `machine` (+ a `groups`
// stub for the tenant FK) in the in-memory better-sqlite3 test
// databases of instrumented plugins.
export const MACHINES_TEST_DDL = `
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE machine (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, tenant_id INTEGER REFERENCES groups(id) ON DELETE cascade, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other', host TEXT NOT NULL, port INTEGER, capabilities TEXT, secret_ref TEXT, health_url TEXT, status TEXT NOT NULL DEFAULT 'unknown', last_seen_at INTEGER, last_check_at INTEGER, check_error TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER);
CREATE UNIQUE INDEX machine_scope_name_idx ON machine (scope, name);
CREATE INDEX machine_tenant_idx ON machine (tenant_id);
CREATE INDEX machine_status_idx ON machine (status);
`;

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	machinesTablesPlugin,
	machinesServicesPlugin,
	machinesChromePlugin,
	machinesPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"machines.tables": true;
		"machines.services": true;
		"machines.chrome": true;
		"machines.panel": true;
	}
}
