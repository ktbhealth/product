import { index, integer, sqliteTable, text } from "@ktb/db/table";

/**
 * Job runs (PL-007): status projection for the generic jobs backbone
 * (@ktb/jobs-port). One row per enqueued job — `id` is the
 * message-envelope id, `kind` the consumer dispatch key,
 * `payload_ref` an optional pointer to where the payload lives (never
 * PHI or blob bytes inline). `tenant_id` NULL = personal scope.
 *
 * Owned by @ktb/jobs-port: the port writes here and the /platform jobs
 * console reads it. Domain rows (e.g. consultations.audio_status)
 * remain their own projections — migrating them onto job_runs is a
 * documented follow-up, not v1. Aggregated into `@ktb/db/schema` by
 * tools/gen-db-schema.mjs.
 */
export const jobRuns = sqliteTable(
	"job_runs",
	{
		id: text("id").primaryKey(),
		kind: text("kind").notNull(),
		/** queued | processing | done | failed — see @ktb/jobs-port JobStatus. */
		status: text("status").notNull().default("queued"),
		payloadRef: text("payload_ref"),
		error: text("error"),
		tenantId: integer("tenant_id"),
		// Epoch milliseconds — plain integer (not timestamp mode) so the
		// projection rows stay number-typed for the console feed.
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [index("job_runs_kind_status_idx").on(table.kind, table.status)],
);
