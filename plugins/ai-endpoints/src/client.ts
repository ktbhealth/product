import { BotIcon, PlugZapIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { AgentsPanelPage, EndpointsPanelPage } from "./platform-page.tsx";

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
		meta: { keywords: ["ai", "tables"] },
		// Mirrors aiEndpointsTablesPlugin — drizzle schema never reaches
		// the client bundle.
		requiredDeps: [],
	}),
	definePlugin({
		id: "ai.endpoints.services",
		meta: { keywords: ["ai", "services"] },
		requiredDeps: ["ai.endpoints.tables"],
		optionalDeps: ["credentials.services"],
	}),
	definePlugin({
		// Mirrors aiEndpointsRoutesPlugin — the /api route subtree is
		// server-only; the client carries the bare id for parity.
		id: "ai-endpoints.routes",
		meta: { keywords: ["ai", "routes"] },
	}),
	definePlugin({
		id: "ai.endpoints.chrome",
		meta: { keywords: ["ai", "ui"] },
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
			{
				id: "ai-agents.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/ai/agents",
						label: "Agents",
						icon: BotIcon,
						group: "AI",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "ai.endpoints.panel",
		meta: { keywords: ["ai", "ui"] },
		requiredDeps: ["platform.panel", "ai.endpoints.services"],
		panel: {
			pages: [
				{
					id: "ai.endpoints",
					path: "/platform/ai/endpoints",
					component: EndpointsPanelPage,
				},
				{
					id: "ai.agents",
					path: "/platform/ai/agents",
					component: AgentsPanelPage,
				},
			],
		},
	}),
];

export type { AgentLinkRow, EndpointCard } from "./index.ts";
