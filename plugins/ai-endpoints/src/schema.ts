import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `ai_endpoint` — a generative provider any AI-capable plugin can
 * pick: `acp` JSON-RPC agents or `openai` chat-completions endpoints
 * (Ollama/LM Studio/GPT/Gemini-compat). `secret_ref` stores either the
 * NAME of an env var holding the API key or a `credential:<id>` ref
 * into the credentials store — raw keys never live in tables.
 * Promoted from `eval_llm_endpoint` (F1): `scope` names the consuming
 * surface ("eval" for the lab pickers) and `is_default` marks the
 * endpoint `resolveDefault` hands to callers that don't name one.
 */
export const aiEndpoint = sqliteTable(
	"ai_endpoint",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		name: text().notNull(),
		/** acp | openai */
		kind: text().notNull(),
		baseUrl: text("base_url").notNull(),
		/** Chat model id (openai kind); unused for acp. */
		model: text(),
		sessionId: text("session_id"),
		/** Env var NAME or `credential:<id>` — never the key itself. */
		secretRef: text("secret_ref"),
		/** ACP transport: ws (HTTP, default) | child | ssh — non-ws
		 * transports need a Node-runtime driver. */
		transport: text(),
		/** Consuming surface — e.g. "eval" for the lab's pickers. */
		scope: text().notNull().default("eval"),
		/** Preferred endpoint for callers that don't name one. */
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		timeoutMs: integer("timeout_ms").notNull().default(60_000),
		enabled: integer({ mode: "boolean" }).notNull().default(true),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [index("ai_endpoint_enabled_idx").on(table.enabled)],
);
export type AiEndpoint = typeof aiEndpoint.$inferSelect;
