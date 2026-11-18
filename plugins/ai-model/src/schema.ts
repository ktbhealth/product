import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

// Relative import — same rationale as @ktb/vault and @ktb/machines:
// @ktb/groups depends on @ktb/db transitively and @ktb/db's generated
// schema re-exports this module, so a package-specifier import would
// cycle. The FK target is identical either way.
import { groups } from "../../groups/src/schema.ts";

/**
 * AI model catalog (P-098 WS-B) — the registry of models consumers
 * (LLM factories, eval judges, transcription adapters) resolve
 * against, replacing the bare `model` string column on endpoints.
 *
 * `endpointId` is a SOFT reference to `ai_endpoint.id` (plugins/
 * ai-provider): cross-plugin table references stay plain integers so
 * either plugin can be absent at migrate time — same convention as
 * `ai_endpoint.machine_id` → `machine.id`.
 *
 * `modelId` is the provider-side identifier ("qwen2.5:7b-instruct",
 * "gemini-2.0-flash", "@cf/…"); `name` is the platform label.
 * `capabilities` is a JSON array of workload kinds the model serves
 * ("chat", "vision", "asr", "tts", "judge", "embed"). No credentials
 * or prompts live here — those are vault refs / the ai-prompt plugin.
 *
 * Scoping mirrors `machine`/`vault_secret`: `scope` is `"platform"`
 * (tenantId NULL — shared catalog, platform-admin managed) or the
 * tenant id as text; `tenantId` stays a real FK for cascade + queries.
 */
export const aiModel = sqliteTable(
	"ai_model",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** "platform" | String(tenantId) — the scope half of identity. */
		scope: text().notNull(),
		/** NULL = platform scope; set = owning clinic (groups.id). */
		tenantId: integer("tenant_id").references(() => groups.id, { onDelete: "cascade" }),
		/** Optional ai_endpoint row this model is served through. */
		endpointId: integer("endpoint_id"),
		/** Platform label — unique per scope (e.g. "local-qwen", "gemini-flash"). */
		name: text().notNull(),
		/** Provider-side model identifier sent on the wire. */
		modelId: text("model_id").notNull(),
		/** "chat" | "vision" | "asr" | "tts" | "judge" | "embed" | "other". */
		kind: text().notNull().default("chat"),
		/** JSON array of served capabilities — superset of `kind`. */
		capabilities: text(),
		contextTokens: integer("context_tokens"),
		/** "free" | "low" | "medium" | "high" — relative cost tier. */
		costTier: text("cost_tier"),
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		enabled: integer().notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("ai_model_scope_name_idx").on(table.scope, table.name),
		index("ai_model_tenant_idx").on(table.tenantId),
		index("ai_model_endpoint_idx").on(table.endpointId),
		index("ai_model_kind_idx").on(table.kind),
	],
);
export type AiModel = typeof aiModel.$inferSelect;
export type AiModelKind = "chat" | "vision" | "asr" | "tts" | "judge" | "embed" | "other";
