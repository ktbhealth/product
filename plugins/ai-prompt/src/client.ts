import { MessageSquareTextIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { PromptsPanelPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the Intelligence-group sidebar entry and the serializable panel page
 * descriptor. Guard/loader Effects stay server-side. Parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "ai.prompt.tables",
		meta: { keywords: ["ai", "tables"] },
	}),
	definePlugin({
		id: "ai.prompt.services",
		meta: { keywords: ["ai", "services"] },
		// Mirrors aiPromptServicesPlugin — audit is optional server-side.
		optionalDeps: ["audit.services"],
	}),
	definePlugin({
		id: "ai.prompt.chrome",
		meta: { keywords: ["ai", "ui"] },
		requiredDeps: ["platform.panel"],
		chrome: [
			{
				id: "ai-prompt.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/ai/prompts",
						label: "Prompts",
						icon: MessageSquareTextIcon,
						group: "Intelligence",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "ai.prompt.panel",
		meta: { keywords: ["ai", "ui"] },
		requiredDeps: ["platform.panel", "ai.prompt.services"],
		panel: {
			pages: [
				{
					id: "ai-prompts",
					path: "/platform/ai/prompts",
					component: PromptsPanelPage,
				},
			],
		},
	}),
];

export type { PromptCard, PromptVariable } from "./prompts.ts";
