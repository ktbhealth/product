import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

// Relative imports on purpose: drizzle-kit loads the composed schema
// through a CJS resolver that cannot follow `@ktb/*` package
// specifiers — same pattern as plugins/doctors/src/schema.ts.
import { evalInstance, evalInstanceItem } from "../../eval-persona/src/schema.ts";

/**
 * Eval run tables — step 3 of the linear eval pipeline (personas →
 * generated consultations → eval runs; steps 1–2 live in
 * plugins/eval-persona):
 *
 * - `eval_run` — one eval execution over a reviewed cohort. The
 *   cohort is a generation instance's approved items: `instance_id`
 *   links the run back to it (set null if the instance is deleted —
 *   the run record survives), while `params` records the resolved
 *   input set ({itemIds}) so the run is replayable/auditable even
 *   then. The run NEVER regenerates consultations — the gold script
 *   on each item is the corpus; the runner synthesizes audio from it,
 *   ASRs it and scores per-stage metrics.
 * - `eval_run_sample` — per-item outcome: the runner fills `result`
 *   with its metrics JSON (wer, cleanup.werAfter, anamnesis
 *   completeness, diff material, audioUri).
 *
 * Plugin-owned table definitions (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts.
 */

export const evalRun = sqliteTable(
	"eval_run",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** The cohort this run was launched from — the generation
		 * instance whose approved items were sampled. Nullable +
		 * set-null: a hand-picked or orphaned run keeps its params. */
		instanceId: integer("instance_id").references(() => evalInstance.id, {
			onDelete: "set null",
		}),
		/** JSON: {instanceId, itemIds} — the exact input set the run
		 * executed, recorded at start so the run replays/audits
		 * independently of later edits to the cohort. */
		params: text().notNull().default("{}"),
		/** queued | running | done | failed */
		status: text().notNull().default("queued"),
		total: integer().notNull().default(0),
		done: integer().notNull().default(0),
		/** JSON summary: mean WER, gate verdict, engine fingerprints. */
		summary: text(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
		createdBy: text("created_by"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("eval_run_instance_idx").on(table.instanceId)],
);
export type EvalRun = typeof evalRun.$inferSelect;

export const evalRunSample = sqliteTable(
	"eval_run_sample",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		runId: integer("run_id")
			.notNull()
			.references(() => evalRun.id, { onDelete: "cascade" }),
		/** The generated consultation (eval_instance_item) this sample
		 * scored — cascades with the item: deleting the corpus removes
		 * its run evidence too. */
		itemId: integer("item_id")
			.notNull()
			.references(() => evalInstanceItem.id, { onDelete: "cascade" }),
		/** pending | ok | failed */
		status: text().notNull().default("pending"),
		/** JSON: asrText, correctedText, metrics, verdicts, conf bands. */
		result: text(),
		error: text(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [uniqueIndex("eval_run_sample_run_item_idx").on(table.runId, table.itemId)],
);
export type EvalRunSample = typeof evalRunSample.$inferSelect;
