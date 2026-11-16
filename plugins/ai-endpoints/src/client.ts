import { PlugZapIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { EndpointsPanelPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the AI-group sidebar entry and the serializable panel page
 * descriptor. Guard/loader Effects stay server-side. Parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "ai.endpoints.tables",
		// Mirrors aiEndpointsTablesPlugin — drizzle schema never reaches
		// the client bundle.
		requiredDeps: [],
	}),
	definePlugin({
		id: "ai.endpoints.services",
		requiredDeps: ["ai.endpoints.tables"],
		optionalDeps: ["credentials.services"],
	}),
	definePlugin({
		// Mirrors aiEndpointsRoutesPlugin — the /api route subtree is
		// server-only; the client carries the bare id for parity.
		id: "ai-endpoints.routes",
	}),
	definePlugin({
		id: "ai.endpoints.chrome",
		requiredDeps: ["platform.panel"],
		chrome: [
			{
				id: "ai-endpoints.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/ai/endpoints",
						label: "Endpoints",
						icon: PlugZapIcon,
						group: "AI",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "ai.endpoints.panel",
		requiredDeps: ["platform.panel", "ai.endpoints.services"],
		panel: {
			pages: [
				{
					id: "ai.endpoints",
					path: "/platform/ai/endpoints",
					component: EndpointsPanelPage,
				},
			],
		},
	}),
];

export type { EndpointCard } from "./index.ts";
