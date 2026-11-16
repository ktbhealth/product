import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Relative imports on purpose: drizzle-kit loads the composed schema
// through a CJS resolver that cannot follow `@ktb/*` package
// specifiers — same pattern as plugins/eval-validator/src/schema.ts.
import { aiEndpoint } from "../../ai-endpoints/src/schema.ts";
import { evalPersona, evalPersonaBatch } from "../../eval-validator/src/schema.ts";

/**
 * Eval lab tables (P-081 follow-up): the persona/instance surfaces of
 * the Eval console group.
 *
 * - `eval_persona_def` — the CRUD setup entity: a curated persona
 *   (patient+doctor demographics) instances can select explicitly.
 * - `eval_instance` — one generation run: which defs (or how many
 *   random), which `ai_endpoint` (the AI plugin's provider table —
 *   endpoint CRUD/resolution lives in `plugins/ai-endpoints`), target
 *   duration, progress counters and the eval_persona_batch its
 *   generated rows land in (the validator review/run flow consumes
 *   them unchanged).
 * - `eval_instance_item` — per-persona generation slot with its own
 *   status, so the UI can show live per-item progress and partial
 *   failures instead of a single opaque spinner.
 */

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
		endpointId: integer("endpoint_id").references(() => aiEndpoint.id, {
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
		/** Stamp written by the atomic pending→generating claim — a claim
		 * older than the stale threshold means the request died
		 * mid-generation and the next tick reclaims the item. */
		claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [index("eval_instance_item_instance_idx").on(table.instanceId)],
);
export type EvalInstanceItem = typeof evalInstanceItem.$inferSelect;
