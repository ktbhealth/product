import { CpuIcon } from "lucide-react";

import { Effect } from "effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { AiModels, AiModelsLive, type ModelCard } from "./models.ts";
import { ModelsPanelPage } from "./platform-page.tsx";
import { aiModel } from "./schema.ts";

export { aiModel } from "./schema.ts";
export type { AiModel, AiModelKind } from "./schema.ts";
export { AiModels, AiModelsLive, ModelError, type ModelCard } from "./models.ts";

export const aiModelTablesPlugin = definePlugin({
	id: "ai.model.tables",
	meta: { keywords: ["ai", "tables"] },
	tables: { aiModel },
});

/**
 * AI model catalog service (P-098 WS-B): CRUD + ungated `resolve`/
 * `resolveDefault` capability reads over the `ai_model` table.
 * `endpointId` is a soft ref into plugins/ai-provider — no cross-plugin
 * FK. Audit resolves via serviceOption — absence is legal.
 */
export const aiModelServicesPlugin = definePlugin({
	id: "ai.model.services",
	meta: { keywords: ["ai", "services"] },
	optionalDeps: ["audit.services"],
	services: AiModelsLive,
});

export const aiModelChromePlugin = definePlugin({
	id: "ai.model.chrome",
	i18nKeys: {
		groups: { Intelligence: "panel_group_intelligence" },
	},
	meta: { keywords: ["ai", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
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
					group: "Intelligence",
				},
			},
		},
	],
});

export const aiModelPanelPlugin = definePlugin({
	id: "ai.model.panel",
	meta: { keywords: ["ai", "ui"] },
	requiredDeps: [platformPanelPlugin.id, aiModelServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "ai-models",
				path: "/platform/ai/models",
				component: ModelsPanelPage,
				loader: () =>
					Effect.gen(function* () {
						const models = yield* AiModels;
						return yield* models.list({ scope: "platform" }).pipe(
							Effect.catchTags({
								/* v8 ignore next -- platform-scope list raises neither */
								ModelError: () => Effect.succeed([] as ModelCard[]),
								/* v8 ignore next -- platform-scope list raises neither */
								TenantForbidden: () => Effect.succeed([] as ModelCard[]),
								Forbidden: () => Effect.succeed([] as ModelCard[]),
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
	aiModelTablesPlugin,
	aiModelServicesPlugin,
	aiModelChromePlugin,
	aiModelPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"ai.model.tables": true;
		"ai.model.services": true;
		"ai.model.chrome": true;
		"ai.model.panel": true;
	}
}
