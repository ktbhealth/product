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
		id: "ai.provider.tables",
		meta: { keywords: ["ai", "tables"] },
		// Mirrors aiEndpointsTablesPlugin — drizzle schema never reaches
		// the client bundle.
		requiredDeps: [],
	}),
	definePlugin({
		id: "ai.provider.services",
		meta: { keywords: ["ai", "services"] },
		requiredDeps: ["ai.provider.tables"],
		optionalDeps: ["credentials.services", "vault.secrets", "machines.services"],
	}),
	definePlugin({
		// Mirrors aiEndpointsRoutesPlugin — the /api route subtree is
		// server-only; the client carries the bare id for parity.
		id: "ai-provider.routes",
		meta: { keywords: ["ai", "routes"] },
	}),
	definePlugin({
		id: "ai.provider.chrome",
		meta: { keywords: ["ai", "ui"] },
		requiredDeps: ["platform.panel"],
		chrome: [
			{
				id: "ai-provider.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/ai/endpoints",
						label: "Endpoints",
						icon: PlugZapIcon,
						group: "AI platform",
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
						group: "AI platform",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "ai.provider.panel",
		meta: { keywords: ["ai", "ui"] },
		requiredDeps: ["platform.panel", "ai.provider.services"],
		panel: {
			pages: [
				{
					id: "ai.provider",
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
