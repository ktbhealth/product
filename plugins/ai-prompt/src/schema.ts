import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

// Relative import — same rationale as @ktb/vault/@ktb/machines:
// @ktb/groups depends on @ktb/db transitively and @ktb/db's generated
// schema re-exports this module, so a package-specifier import would
// cycle. The FK target is identical either way.
import { groups } from "../../groups/src/schema.ts";

/**
 * AI prompt registry (P-098 WS-C) — versioned prompts as data,
 * replacing hardcoded PROMPT/CLEANUP_SYSTEM_PROMPT/eval scriptgen
 * strings. Consumers resolve `{name, version?, locale?}` through
 * `AiPrompts.resolve`; the resolved template + variable schema feed
 * prompt construction at the edge.
 *
 * Versioning: `(scope, name, version, locale)` is unique — bumping
 * `version` creates a new row, never mutates history, so eval
 * experiments can pin `name@version` for reproducibility (T-135).
 * `locale` is "" for locale-neutral prompts or a BCP-47 tag
 * ("pt-BR", "en", "es"); resolution prefers exact locale, then "".
 *
 * `variables` is a JSON array of `{name, required?, description?}` —
 * the template's declared inputs, validated by consumers. `modelHint`
 * optionally names an ai_model catalog row/kind the prompt targets.
 *
 * Scoping mirrors `ai_model`/`machine`: `scope` is `"platform"`
 * (tenantId NULL) or the tenant id as text; `tenantId` is a real FK.
 */
export const aiPrompt = sqliteTable(
	"ai_prompt",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** "platform" | String(tenantId) — the scope half of identity. */
		scope: text().notNull(),
		/** NULL = platform scope; set = owning clinic (groups.id). */
		tenantId: integer("tenant_id").references(() => groups.id, { onDelete: "cascade" }),
		/** Prompt family — e.g. "anamnesis.extract", "eval.judge", "consult.scriptgen". */
		name: text().notNull(),
		/** Monotonic per (scope, name) — history is append-only. */
		version: integer().notNull(),
		/** "" = locale-neutral; otherwise BCP-47 ("pt-BR", "en", "es"). */
		locale: text().notNull().default(""),
		/** The prompt template — consumers interpolate declared variables. */
		template: text().notNull(),
		/** JSON array of `{name, required?, description?}` variable decls. */
		variables: text(),
		/** Optional hint for model selection — free-form (kind or model name). */
		modelHint: text("model_hint"),
		/** System-prompt flag — consumers may place it differently. */
		isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		enabled: integer().notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("ai_prompt_scope_name_version_locale_idx").on(
			table.scope,
			table.name,
			table.version,
			table.locale,
		),
		index("ai_prompt_tenant_idx").on(table.tenantId),
		index("ai_prompt_name_idx").on(table.name),
	],
);
export type AiPrompt = typeof aiPrompt.$inferSelect;
