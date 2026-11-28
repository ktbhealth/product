import { MessageSquareTextIcon } from "lucide-react";

import { Effect } from "effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { AiPrompts, AiPromptsLive, type PromptCard } from "./prompts.ts";
import { PromptsPanelPage } from "./platform-page.tsx";
import { aiPrompt } from "./schema.ts";

export { aiPrompt } from "./schema.ts";
export type { AiPrompt } from "./schema.ts";
export {
	AiPrompts,
	AiPromptsLive,
	PromptError,
	type PromptCard,
	type PromptVariable,
} from "./prompts.ts";

export const aiPromptTablesPlugin = definePlugin({
	id: "ai.prompt.tables",
	meta: { keywords: ["ai", "tables"] },
	tables: { aiPrompt },
});

/**
 * AI prompt registry service (P-098 WS-C): versioned prompt CRUD +
 * the ungated `resolve` PromptPort read. Writes append versions —
 * history is never mutated. Audit resolves via serviceOption —
 * absence is legal.
 */
export const aiPromptServicesPlugin = definePlugin({
	id: "ai.prompt.services",
	meta: { keywords: ["ai", "services"] },
	optionalDeps: ["audit.services"],
	services: AiPromptsLive,
});

export const aiPromptChromePlugin = definePlugin({
	id: "ai.prompt.chrome",
	i18nKeys: {
		groups: { Intelligence: "panel_group_intelligence" },
	},
	meta: { keywords: ["ai", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
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
});

export const aiPromptPanelPlugin = definePlugin({
	id: "ai.prompt.panel",
	meta: { keywords: ["ai", "ui"] },
	requiredDeps: [platformPanelPlugin.id, aiPromptServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "ai-prompts",
				path: "/platform/ai/prompts",
				component: PromptsPanelPage,
				loader: () =>
					Effect.gen(function* () {
						const prompts = yield* AiPrompts;
						return yield* prompts.list({ scope: "platform" }).pipe(
							Effect.catchTags({
								/* v8 ignore next -- platform-scope list raises neither */
								PromptError: () => Effect.succeed([] as PromptCard[]),
								/* v8 ignore next -- platform-scope list raises neither */
								TenantForbidden: () => Effect.succeed([] as PromptCard[]),
								Forbidden: () => Effect.succeed([] as PromptCard[]),
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
	aiPromptTablesPlugin,
	aiPromptServicesPlugin,
	aiPromptChromePlugin,
	aiPromptPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"ai.prompt.tables": true;
		"ai.prompt.services": true;
		"ai.prompt.chrome": true;
		"ai.prompt.panel": true;
	}
}
