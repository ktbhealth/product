import { index, integer, sqliteTable, text } from "@ktb/db/table";

/**
 * Scheduled jobs (runtime scheduler): DB-backed schedule definitions the
 * `scheduler-heartbeat` cron sweep claims and dispatches through the
 * jobs backbone (@ktb/jobs-port). One row per schedule — `cron_expr`
 * for recurring work, `run_at` for one-off fires; exactly one is set.
 *
 * `next_run_at` is precomputed at write/claim time so the sweep is a
 * plain indexed range scan — no cron evaluation on the hot path.
 * `claimed_until` is the lease that makes the claim atomic across
 * isolates: a sweeper only fires rows whose lease expired, and the
 * conditional UPDATE is the lock (no in-memory coordination).
 *
 * Owned by @ktb/scheduler-port: the port writes here and the
 * /platform/cron console reads it. `tenant_id` NULL = global scope;
 * `params` is the JSON payload the consumer receives — never PHI or
 * secrets inline. Aggregated into `@ktb/db/schema` by
 * tools/gen-db-schema.mjs.
 */
export const scheduledJobs = sqliteTable(
	"scheduled_jobs",
	{
		id: text("id").primaryKey(),
		/** Consumer dispatch key — must be a registered job kind. */
		kind: text("kind").notNull(),
		/** JSON payload forwarded to the job envelope; NULL = {}. */
		params: text("params"),
		/** Standard 5-field cron expression (UTC); NULL on one-off rows. */
		cronExpr: text("cron_expr"),
		/** One-off fire time (epoch ms); NULL on recurring rows. */
		runAt: integer("run_at"),
		/** Next due time (epoch ms) — the sweep's range-scan key. */
		nextRunAt: integer("next_run_at").notNull(),
		/** Claim lease expiry (epoch ms); NULL = unclaimed. */
		claimedUntil: integer("claimed_until"),
		/** Last fire time (epoch ms); NULL = never fired. */
		lastRunAt: integer("last_run_at"),
		/** active | paused | done — see @ktb/scheduler-port. */
		status: text("status").notNull().default("active"),
		tenantId: integer("tenant_id"),
		/** Account id of the admin who created the row (audit trail). */
		createdBy: text("created_by"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		// Sweep filter: status='active' AND next_run_at <= now.
		index("scheduled_jobs_due_idx").on(table.status, table.nextRunAt),
	],
);
