import { index, integer, sqliteTable, text, uniqueIndex } from "@ktb/db/table";

/**
 * Wizard tables: admin-authored wizard DEFINITIONS (`wizard_defs` —
 * the DB half of the `wizard.def` contribution kind; code-contributed
 * defs live in plugin manifests) and per-user RUNS (`wizard_runs` —
 * one row per started wizard, carrying a snapshot of the definition
 * so later def edits never mutate an in-flight run).
 *
 * `wizard_defs.key` is the wizard id — the same slug `wizard.def`
 * contributions and `/wizards/<key>` URLs use; unique across DB defs.
 * `definition_json` is a serialized {@link WizardDefinition}
 * (plugins/wizards/src/definition.ts) validated on write AND on read.
 *
 * `wizard_runs` stores `definition_json` (snapshot), `answers_json`
 * (per-step-id submitted values), `status`
 * ("active" | "completed" | "abandoned"), `step_index` (the last
 * resolved position — the interpreter re-derives the visible step
 * from it + answers) and `owner_id` (session user id; "" only for
 * principal-less system flows, which the service rejects anyway).
 * `completed_at` stays NULL until the run finishes or is abandoned.
 *
 * Plugin-owned table definitions (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts — consumers
 * keep importing from `@ktb/db/schema` (or `@ktb/wizards/schema`).
 */
export const wizardDefs = sqliteTable(
	"wizard_defs",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** Wizard id — slug, unique, doubles as the /wizards/<key> segment. */
		key: text().notNull(),
		title: text().notNull(),
		description: text().notNull().default(""),
		/** JSON-serialized WizardDefinition (validated on write/read). */
		definitionJson: text("definition_json").notNull(),
		published: integer({ mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [uniqueIndex("wizard_defs_key_idx").on(table.key)],
);

export const wizardRuns = sqliteTable(
	"wizard_runs",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** Wizard id the run was started against (def snapshot in definition_json). */
		key: text().notNull(),
		/** JSON-serialized WizardDefinition snapshot taken at startRun. */
		definitionJson: text("definition_json").notNull(),
		/** "active" | "completed" | "abandoned". */
		status: text().notNull().default("active"),
		/** Position the interpreter resumes from (answers re-resolve visibility). */
		stepIndex: integer("step_index").notNull().default(0),
		/** JSON object: step id → submitted value. */
		answersJson: text("answers_json").notNull().default("{}"),
		/** Session user id that owns the run — runs are private. */
		ownerId: text("owner_id").notNull().default(""),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }),
	},
	(table) => [index("wizard_runs_owner_idx").on(table.ownerId, table.status)],
);

export type WizardDefRow = typeof wizardDefs.$inferSelect;
export type WizardDefInsert = typeof wizardDefs.$inferInsert;
export type WizardRunRow = typeof wizardRuns.$inferSelect;
export type WizardRunInsert = typeof wizardRuns.$inferInsert;
