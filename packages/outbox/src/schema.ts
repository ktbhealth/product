import { index, integer, sqliteTable, text } from "@ktb/db/table";

/**
 * Outbox (reliable delivery): pending-work table written by domain
 * code BEFORE attempting external delivery, then drained
 * asynchronously by @ktb/outbox with retry + backoff. One row per
 * outbound side effect (today: transactional email under kind
 * "email"); `payload` is the JSON-encoded deliverer input — for email
 * the full rendered EmailMessage, so delivery never re-derives copy.
 *
 * Owned by @ktb/outbox: producers in packages/, plugins/ and apps/
 * all write here and the drain runs at the composition edge. Aggregated
 * into `@ktb/db/schema` by tools/gen-db-schema.mjs. `tenant_id` NULL =
 * personal/global scope.
 *
 * Status lifecycle: `pending` (awaiting or retrying delivery) →
 * `done` (deliverer accepted) or `failed` (attempts exhausted — the
 * terminal, operator-visible state). `claimed_until` is the drain
 * lease that makes claims atomic across isolates (same contract as
 * scheduled_jobs): a sweeper only picks rows whose lease expired, and
 * the conditional UPDATE is the lock.
 */
export const outbox = sqliteTable(
	"outbox",
	{
		id: text("id").primaryKey(),
		/** Deliverer dispatch key — must be a registered outbox kind
		 * (e.g. "email"). Rows whose kind has no deliverer stay pending. */
		kind: text("kind").notNull(),
		/** JSON-encoded deliverer payload; never secrets. */
		payload: text("payload").notNull(),
		/** pending | done | failed — see @ktb/outbox OutboxStatus. */
		status: text("status").notNull().default("pending"),
		/** Delivery attempts so far (failed handler runs count). */
		attempts: integer("attempts").notNull().default(0),
		/** Earliest next delivery attempt (epoch ms) — backoff key. */
		nextAttemptAt: integer("next_attempt_at").notNull(),
		/** Claim lease expiry (epoch ms); NULL = unclaimed. */
		claimedUntil: integer("claimed_until"),
		/** Last delivery error (short, no secrets/PHI). */
		error: text("error"),
		tenantId: integer("tenant_id"),
		// Epoch milliseconds — plain integer, same convention as
		// job_runs/scheduled_jobs.
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		// Drain filter: status='pending' AND next_attempt_at <= now.
		index("outbox_pending_idx").on(table.status, table.nextAttemptAt),
	],
);
