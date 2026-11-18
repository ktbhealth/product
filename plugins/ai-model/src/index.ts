import { CpuIcon } from "lucide-react";

import { Effect } from "effect";

import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformPanelPlugin } from "@ktb/platform";

import { AiModels, AiModelsLive, type ModelCard } from "./models.ts";
import { ModelsPanelPage } from "./platform-page.tsx";
import { aiModel } from "./schema.ts";

export { aiModel } from "./schema.ts";
export type { AiModel, AiModelKind } from "./schema.ts";
export { AiModels, AiModelsLive, ModelError, type ModelCard } from "./models.ts";

/** Platform-admin gate for the panel page — same contract as the
 * /platform/audit admin surface: hard deny for non-admins, the
 * AiModels service re-checks every call anyway. */
const adminGuard = () =>
	Effect.gen(function* () {
		const platformAdmin = yield* PlatformAdmin;
		return yield* platformAdmin.requireAdmin().pipe(
			Effect.as(true),
			Effect.catchTag("Forbidden", () => Effect.succeed(false)),
		);
	});

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
			{
				id: "ai-models",
				path: "/platform/ai/models",
				component: ModelsPanelPage,
				guard: adminGuard,
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
			},
		],
	},
});

// Re-exported for tests: DDL that creates `ai_model` (+ a `groups`
// stub for the tenant FK) in the in-memory better-sqlite3 test
// databases of instrumented plugins.
export const AI_MODEL_TEST_DDL = `
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE ai_model (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, tenant_id INTEGER REFERENCES groups(id) ON DELETE cascade, endpoint_id INTEGER, name TEXT NOT NULL, model_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', capabilities TEXT, context_tokens INTEGER, cost_tier TEXT, is_default INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER);
CREATE UNIQUE INDEX ai_model_scope_name_idx ON ai_model (scope, name);
CREATE INDEX ai_model_tenant_idx ON ai_model (tenant_id);
CREATE INDEX ai_model_endpoint_idx ON ai_model (endpoint_id);
CREATE INDEX ai_model_kind_idx ON ai_model (kind);
`;

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
