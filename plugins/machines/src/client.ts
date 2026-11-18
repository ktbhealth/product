import { ServerIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { MachinesPanelPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the AI-group sidebar entry and the serializable panel page
 * descriptor. Guard/loader Effects stay server-side. Parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "machines.tables",
		meta: { keywords: ["machines", "tables"] },
	}),
	definePlugin({
		id: "machines.services",
		meta: { keywords: ["machines", "services"] },
		// Mirrors machinesServicesPlugin — audit is optional server-side.
		optionalDeps: ["audit.services"],
	}),
	definePlugin({
		id: "machines.chrome",
		meta: { keywords: ["machines", "ui"] },
		requiredDeps: ["platform.panel"],
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
	}),
	definePlugin({
		id: "machines.panel",
		meta: { keywords: ["machines", "ui"] },
		requiredDeps: ["platform.panel", "machines.services"],
		panel: {
			pages: [
				{
					id: "machines",
					path: "/platform/ai/machines",
					component: MachinesPanelPage,
				},
			],
		},
	}),
];

export type { MachineCard } from "./machines.ts";
