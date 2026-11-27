import { index, integer, primaryKey, sqliteTable, text } from "./table.ts";

/**
 * Orchestration persistence (phase 2, @ktb/orchestrator): host-owned
 * tables for durable runs, written only by the orchestrator package's
 * durable runner and read by its step-job consumer — same host-owned
 * pattern as job_runs/plugin_state (the tables cannot live in a plugin
 * without recreating the workspace cycle).
 *
 * - `orchestration_defs` — persisted orchestration defs (data-only;
 *   defs with inline `handler` kinds are rejected at upsert because
 *   functions cannot round-trip through JSON). `id` is the def id,
 *   `version` the def's declared version ("1" when undeclared);
 *   upsert replaces the latest row. `enabled = 0` rows are skipped by
 *   `loadStoredDefs` at boot.
 * - `orchestration_runs` — one row per durable run. `state` is the
 *   merged node-state JSON object (inspection surface);
 *   `runtime` is the full {@link OrchestrationSnapshot} the session
 *   restores from (node counters, fanIn buffers, processed events,
 *   trace, policies). `status`: running | done | failed | cancelled.
 *   `error` carries the run-level failure message (budget exceeded,
 *   corrupt state, enqueue failure) — node-level failures live in the
 *   trace/events, not here. `tenant_id` is the tenant scope the run
 *   was started under (stamped from the bound `Tenant` at start;
 *   NULL = platform/personal scope) — attribution + the
 *   `orchestrator.step` envelope's tenant, same convention as
 *   `job_runs.tenant_id`. Defs stay global; events/node_runs inherit
 *   scope through `run_id` and carry no column of their own.
 * - `orchestration_events` — the durable pending-event queue: rows
 *   with the lowest `seq` per `run_id` route first. Rewritten
 *   wholesale at each step boundary (delete + reinsert), so `seq` is
 *   positional, not a global sequence.
 * - `orchestration_node_runs` — the durable NodeRunRecord trace,
 *   appended per step (`seq` = index into the run's trace array);
 *   upserted on (run_id, seq) so a replayed step batch rewrites
 *   identical rows instead of conflicting.
 */
export const orchestrationDefs = sqliteTable("orchestration_defs", {
	id: text("id").primaryKey(),
	version: text("version").notNull(),
	/** Serialized OrchestrationDef JSON (plain text — helpers own the
	 * parse/serialize boundary so corrupt rows read as absent). */
	def: text("def").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	// Epoch milliseconds — plain integer, same convention as job_runs.
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const orchestrationRuns = sqliteTable(
	"orchestration_runs",
	{
		id: text("id").primaryKey(),
		defId: text("def_id").notNull(),
		defVersion: text("def_version").notNull(),
		/** running | done | failed | cancelled — see @ktb/orchestrator. */
		status: text("status").notNull().default("running"),
		/** Merged node-state JSON object (the run's public state). */
		state: text("state").notNull(),
		/** Serialized OrchestrationSnapshot JSON — the resume payload. */
		runtime: text("runtime").notNull(),
		/** Run-level failure message; NULL unless status = "failed". */
		error: text("error"),
		/** Tenant scope (`groups.id`) the run was started under; NULL =
		 * platform/personal scope. Plain integer, no FK — same convention
		 * as `job_runs.tenant_id` (host-owned table, `groups` is not
		 * reachable from @ktb/db). */
		tenantId: integer("tenant_id"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("orchestration_runs_def_status_idx").on(table.defId, table.status),
		index("orchestration_runs_tenant_created_idx").on(table.tenantId, table.createdAt),
	],
);

export const orchestrationEvents = sqliteTable(
	"orchestration_events",
	{
		runId: text("run_id").notNull(),
		/** Positional queue index — rewritten per step, not monotonic. */
		seq: integer("seq").notNull(),
		eventId: text("event_id").notNull(),
		eventType: text("event_type").notNull(),
		/** Serialized event payload JSON. */
		payload: text("payload").notNull(),
		source: text("source").notNull(),
		ts: integer("ts").notNull(),
	},
	(table) => [primaryKey({ columns: [table.runId, table.seq] })],
);

export const orchestrationNodeRuns = sqliteTable(
	"orchestration_node_runs",
	{
		runId: text("run_id").notNull(),
		/** Index into the run's trace array — stable across step replays. */
		seq: integer("seq").notNull(),
		nodeId: text("node_id").notNull(),
		/** ok | skipped | failed — see NodeRunRecord.status. */
		status: text("status").notNull(),
		latencyMs: integer("latency_ms").notNull(),
		error: text("error"),
		fires: integer("fires").notNull(),
	},
	(table) => [primaryKey({ columns: [table.runId, table.seq] })],
);
