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
