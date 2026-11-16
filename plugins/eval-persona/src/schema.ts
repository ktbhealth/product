import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Relative imports on purpose: drizzle-kit loads the composed schema
// through a CJS resolver that cannot follow `@ktb/*` package
// specifiers — same pattern as plugins/eval-validator/src/schema.ts.
import { evalPersona, evalPersonaBatch } from "../../eval-validator/src/schema.ts";

/**
 * Eval lab tables (P-081 follow-up): the persona/instance surfaces of
 * the Eval console group.
 *
 * - `eval_llm_endpoint` — a generative provider the lab can pick:
 *   `acp` JSON-RPC agents or `openai` chat-completions endpoints
 *   (Ollama/LM Studio/GPT/Gemini-compat). `secret_ref` stores the
 *   NAME of an env var holding the API key — credentials never live
 *   in tables.
 * - `eval_persona_def` — the CRUD setup entity: a curated persona
 *   (patient+doctor demographics) instances can select explicitly.
 * - `eval_instance` — one generation run: which defs (or how many
 *   random), which endpoint, target duration, progress counters and
 *   the eval_persona_batch its generated rows land in (the validator
 *   review/run flow consumes them unchanged).
 * - `eval_instance_item` — per-persona generation slot with its own
 *   status, so the UI can show live per-item progress and partial
 *   failures instead of a single opaque spinner.
 */

export const evalLlmEndpoint = sqliteTable(
	"eval_llm_endpoint",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		name: text().notNull(),
		/** acp | openai */
		kind: text().notNull(),
		baseUrl: text("base_url").notNull(),
		/** Chat model id (openai kind); unused for acp. */
		model: text(),
		sessionId: text("session_id"),
		/** Env var NAME holding the API key — never the key itself. */
		secretRef: text("secret_ref"),
		/** ACP transport: ws (HTTP, default) | child | ssh — non-ws
		 * transports need a Node-runtime driver. */
		transport: text(),
		timeoutMs: integer("timeout_ms").notNull().default(60_000),
		enabled: integer({ mode: "boolean" }).notNull().default(true),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [index("eval_llm_endpoint_enabled_idx").on(table.enabled)],
);
export type EvalLlmEndpoint = typeof evalLlmEndpoint.$inferSelect;

export const evalPersonaDef = sqliteTable("eval_persona_def", {
	id: integer().primaryKey({ autoIncrement: true }),
	/** Display label for pickers — e.g. "idosa nordestina coloquial". */
	name: text().notNull(),
	/** JSON: enriched Persona shape (axes + names + doctor pair). */
	persona: text().notNull(),
	notes: text(),
	createdBy: text("created_by"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});
export type EvalPersonaDef = typeof evalPersonaDef.$inferSelect;

export const evalInstance = sqliteTable(
	"eval_instance",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		name: text().notNull(),
		/** selected | random */
		mode: text().notNull(),
		endpointId: integer("endpoint_id").references(() => evalLlmEndpoint.id, {
			onDelete: "set null",
		}),
		/** JSON: { seed, count, minutes } the generation used. */
		params: text().notNull(),
		/** draft | generating | ready | failed */
		status: text().notNull().default("draft"),
		total: integer().notNull().default(0),
		done: integer().notNull().default(0),
		/** The eval_persona_batch generated personas land in — review
		 * and eval runs consume them through the validator flow. */
		batchId: integer("batch_id").references(() => evalPersonaBatch.id, {
			onDelete: "set null",
		}),
		createdBy: text("created_by"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [index("eval_instance_status_idx").on(table.status)],
);
export type EvalInstance = typeof evalInstance.$inferSelect;

export const evalInstanceItem = sqliteTable(
	"eval_instance_item",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		instanceId: integer("instance_id")
			.notNull()
			.references(() => evalInstance.id, { onDelete: "cascade" }),
		personaDefId: integer("persona_def_id").references(() => evalPersonaDef.id, {
			onDelete: "set null",
		}),
		evalPersonaId: integer("eval_persona_id").references(() => evalPersona.id, {
			onDelete: "set null",
		}),
		/** JSON: resolved Persona — from the def upfront for selected
		 * mode, filled in at generation time for random picks. */
		persona: text(),
		/** pending | generating | done | error */
		status: text().notNull().default("pending"),
		error: text(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [index("eval_instance_item_instance_idx").on(table.instanceId)],
);
export type EvalInstanceItem = typeof evalInstanceItem.$inferSelect;
