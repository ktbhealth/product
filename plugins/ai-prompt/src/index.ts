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

// Re-exported for tests: DDL that creates `ai_prompt` (+ a `groups`
// stub for the tenant FK) in the in-memory better-sqlite3 test
// databases of instrumented plugins.
export const AI_PROMPT_TEST_DDL = `
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE ai_prompt (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, tenant_id INTEGER REFERENCES groups(id) ON DELETE cascade, name TEXT NOT NULL, version INTEGER NOT NULL, locale TEXT NOT NULL DEFAULT '', template TEXT NOT NULL, variables TEXT, model_hint TEXT, is_system INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER);
CREATE UNIQUE INDEX ai_prompt_scope_name_version_locale_idx ON ai_prompt (scope, name, version, locale);
CREATE INDEX ai_prompt_tenant_idx ON ai_prompt (tenant_id);
CREATE INDEX ai_prompt_name_idx ON ai_prompt (name);
`;

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
