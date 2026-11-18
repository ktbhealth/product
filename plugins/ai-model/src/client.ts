import { CpuIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { ModelsPanelPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the AI-group sidebar entry and the serializable panel page
 * descriptor. Guard/loader Effects stay server-side. Parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "ai.model.tables",
		meta: { keywords: ["ai", "tables"] },
	}),
	definePlugin({
		id: "ai.model.services",
		meta: { keywords: ["ai", "services"] },
		// Mirrors aiModelServicesPlugin — audit is optional server-side.
		optionalDeps: ["audit.services"],
	}),
	definePlugin({
		id: "ai.model.chrome",
		meta: { keywords: ["ai", "ui"] },
		requiredDeps: ["platform.panel"],
		chrome: [
			{
				id: "ai-model.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/ai/models",
						label: "Models",
						icon: CpuIcon,
						group: "AI platform",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "ai.model.panel",
		meta: { keywords: ["ai", "ui"] },
		requiredDeps: ["platform.panel", "ai.model.services"],
		panel: {
			pages: [
				{
					id: "ai-models",
					path: "/platform/ai/models",
					component: ModelsPanelPage,
				},
			],
		},
	}),
];

export type { ModelCard } from "./models.ts";
