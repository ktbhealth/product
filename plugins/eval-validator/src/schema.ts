import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

// Relative imports on purpose: drizzle-kit loads the composed schema
// through a CJS resolver that cannot follow `@ktb/*` package
// specifiers — same pattern as plugins/doctors/src/schema.ts.
import { doctors } from "../../doctors/src/schema.ts";
import { patients } from "../../patients/src/schema.ts";

/**
 * Eval validator workflow tables (P-081): the in-app surface for
 * generating persona cohorts, reviewing them, and tracking eval runs.
 * Three tables map the workflow one-to-one:
 *
 * - `eval_persona_batch` — one "Generate personas" click. `params`
 *   holds the generator input (count, seed, matrix) so a batch is
 *   replayable. `state` gates the next step: personas can only enter
 *   an eval run when their batch is `approved`.
 * - `eval_persona` — one generated patient+doctor pair with its
 *   rendered script and derived voices, awaiting review. Feedback is
 *   the validator's free-text note; it is carried verbatim into the
 *   next generation round as a constraint hint.
 * - `eval_run` / `eval_run_sample` — the eval execution: a run row
 *   tracks progress (`done`/`total`) and each approved sample gets a
 *   row the runner fills with its metrics JSON.
 *
 * Plugin-owned table definitions (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts.
 */

export const evalPersonaBatch = sqliteTable(
	"eval_persona_batch",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** JSON: { count, seed, variant, locale } the batch was made with. */
		params: text().notNull(),
		createdBy: text("created_by"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("eval_persona_batch_created_at_idx").on(table.createdAt)],
);
export type EvalPersonaBatch = typeof evalPersonaBatch.$inferSelect;

export const evalPersona = sqliteTable(
	"eval_persona",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		batchId: integer("batch_id")
			.notNull()
			.references(() => evalPersonaBatch.id, { onDelete: "cascade" }),
		/** JSON: enriched Persona (region/register/gender/class/edu/name/doctor). */
		persona: text().notNull(),
		/** Rendered script text (turn-joined). */
		script: text().notNull(),
		/** JSON: [{speaker, text}] for per-speaker display. */
		turns: text().notNull(),
		/** JSON: {doctor: alias, patient: alias} derived voices. */
		voices: text().notNull(),
		/** Synthetic entities created with the persona — the patient
		 * row and the doctor row (backing a synthetic `user`). Set
		 * null when the entities are removed on rejection. */
		patientId: integer("patient_id").references(() => patients.id, {
			onDelete: "set null",
		}),
		doctorId: integer("doctor_id").references(() => doctors.id, {
			onDelete: "set null",
		}),
		/** llm | template — which script source rendered the dialogue. */
		scriptMode: text("script_mode"),
		/** under_review | approved | rejected */
		state: text().notNull().default("under_review"),
		/** Validator feedback — verbatim, feeds the regen round. */
		feedback: text(),
		reviewedBy: text("reviewed_by"),
		reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("eval_persona_batch_idx").on(table.batchId),
		index("eval_persona_state_idx").on(table.state),
	],
);
export type EvalPersona = typeof evalPersona.$inferSelect;

export const evalRun = sqliteTable(
	"eval_run",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		batchId: integer("batch_id")
			.notNull()
			.references(() => evalPersonaBatch.id, { onDelete: "cascade" }),
		/** queued | running | done | failed */
		status: text().notNull().default("queued"),
		total: integer().notNull().default(0),
		done: integer().notNull().default(0),
		/** JSON summary: mean WER, gate verdict, engine fingerprints. */
		summary: text(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("eval_run_batch_idx").on(table.batchId)],
);
export type EvalRun = typeof evalRun.$inferSelect;

export const evalRunSample = sqliteTable(
	"eval_run_sample",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		runId: integer("run_id")
			.notNull()
			.references(() => evalRun.id, { onDelete: "cascade" }),
		personaId: integer("persona_id")
			.notNull()
			.references(() => evalPersona.id, { onDelete: "cascade" }),
		/** pending | ok | failed */
		status: text().notNull().default("pending"),
		/** JSON: asrText, correctedText, metrics, verdicts, conf bands. */
		result: text(),
		error: text(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [uniqueIndex("eval_run_sample_run_persona_idx").on(table.runId, table.personaId)],
);
export type EvalRunSample = typeof evalRunSample.$inferSelect;
