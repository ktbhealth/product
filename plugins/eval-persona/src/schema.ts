import { index, integer, sqliteTable, text } from "../../../packages/db/src/table.ts";

// Relative imports on purpose: drizzle-kit loads the composed schema
// through a CJS resolver that cannot follow `@ktb/*` package
// specifiers — same pattern as plugins/eval-validator/src/schema.ts.
import { aiEndpoint } from "../../ai-provider/src/schema.ts";
import { doctors } from "../../doctors/src/schema.ts";
import { patients } from "../../patients/src/schema.ts";

/**
 * Eval pipeline tables — steps 1 and 2 of the linear eval flow
 * (personas → generated consultations → eval runs; step 3 lives in
 * plugins/eval-validator):
 *
 * - `eval_persona_def` — THE persona registry, the single source of
 *   truth for personas. Rows are created on the Personas step only —
 *   manually or LLM/template-generated; generation (step 2) and runs
 *   (step 3) READ this table, never mint parallel persona entities.
 * - `eval_instance` — one consultation-generation run over the
 *   registry: which defs (or a seeded random pick), which
 *   `ai_endpoint` (the AI plugin's provider table — endpoint
 *   CRUD/resolution lives in `plugins/ai-provider`), target
 *   duration, progress counters.
 * - `eval_instance_item` — the corpus unit: one generated synthetic
 *   consultation for one persona. It snapshots the resolved persona,
 *   carries the rendered script/turns/voices and the synthetic
 *   patient+doctor entities, and doubles as the review unit for step
 *   3 (`state` gates entry into an eval run). Per-item generation
 *   status lets the UI show live progress and partial failures.
 *
 * Design note (the "one pipeline" refactor): the old model had TWO
 * persona tables — this registry plus `eval_persona` (a per-batch
 * generated copy the validator minted itself) — so personas and
 * scripts were generated in two disconnected places. The corpus
 * fields moved onto `eval_instance_item` and `eval_persona`/
 * `eval_persona_batch` were dropped: one persona table, one
 * generation step, one reviewable cohort.
 */

export const evalPersonaDef = sqliteTable("eval_persona_def", {
	id: integer().primaryKey({ autoIncrement: true }),
	/** Display label for pickers — e.g. "idosa nordestina coloquial". */
	name: text().notNull(),
	/** JSON: enriched Persona shape (axes + names + doctor pair). */
	persona: text().notNull(),
	notes: text(),
	createdBy: text("created_by"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
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
		createdBy: text("created_by"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
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
		/** The registry persona this consultation was generated for —
		 * set at instance creation in both modes (selected picks it
		 * explicitly, random is a seeded registry pick). */
		personaDefId: integer("persona_def_id").references(() => evalPersonaDef.id, {
			onDelete: "set null",
		}),
		/** JSON: resolved Persona snapshot from the def — kept even if
		 * the def is later edited/deleted so the corpus stays
		 * self-describing for axis aggregation. */
		persona: text(),
		/** Rendered script text (turn-joined) — the gold reference the
		 * eval run synthesizes and diffs against. Null until the item
		 * generates. */
		script: text(),
		/** JSON: [{speaker, text}] for per-speaker display + TTS. */
		turns: text(),
		/** JSON: {doctor: alias, patient: alias} derived voices. */
		voices: text(),
		/** Synthetic entities created with the consultation — the
		 * patient row and the doctor row (backing a synthetic `user`).
		 * Set null when the entities are removed on rejection. */
		patientId: integer("patient_id").references(() => patients.id, {
			onDelete: "set null",
		}),
		doctorId: integer("doctor_id").references(() => doctors.id, {
			onDelete: "set null",
		}),
		/** llm | template — which script source rendered the dialogue. */
		scriptMode: text("script_mode"),
		/** pending | generating | done | error — the GENERATION status
		 * (step 2), distinct from `state` below. */
		status: text().notNull().default("pending"),
		error: text(),
		/** under_review | approved | rejected — the REVIEW gate (step
		 * 3): only approved items enter an eval run. */
		state: text().notNull().default("under_review"),
		/** Reviewer feedback — free text, kept for audit. */
		feedback: text(),
		reviewedBy: text("reviewed_by"),
		reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
		/** Stamp written by the atomic pending→generating claim — a claim
		 * older than the stale threshold means the request died
		 * mid-generation and the next tick reclaims the item. */
		claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("eval_instance_item_instance_idx").on(table.instanceId)],
);
export type EvalInstanceItem = typeof evalInstanceItem.$inferSelect;
