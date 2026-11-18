import { EVAL_PERSONA_TEST_DDL } from "@ktb/eval-persona";

/** DDL mirror of the run tables for in-memory test databases —
 * composed over EVAL_PERSONA_TEST_DDL since the run schema references
 * the step-2 tables (eval_instance / eval_instance_item) plus the
 * synthetic-entity tables rejection deletes.
 *
 * Lives in its own leaf module on purpose: ai-endpoints pins the
 * EVAL_* permission constants from @ktb/eval-validator, which makes
 * eval-persona ↔ eval-validator a benign import cycle — but only as
 * long as neither side dereferences the other's bindings at module
 * top level. A `${EVAL_PERSONA_TEST_DDL}` const inside index.ts did
 * exactly that and crashed under TDZ when the cycle entered through
 * eval-persona. */
export const EVAL_VALIDATOR_TEST_DDL = `${EVAL_PERSONA_TEST_DDL}
CREATE TABLE eval_run (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id INTEGER REFERENCES eval_instance(id) ON DELETE set null, params TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, summary TEXT, started_at INTEGER, finished_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE eval_run_sample (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES eval_run(id) ON DELETE cascade, item_id INTEGER NOT NULL REFERENCES eval_instance_item(id) ON DELETE cascade, status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX eval_run_sample_run_item_idx ON eval_run_sample (run_id, item_id);
`;
