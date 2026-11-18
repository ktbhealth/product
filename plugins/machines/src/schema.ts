import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

// Relative import — same rationale as @ktb/vault: @ktb/groups depends
// on @ktb/db transitively and @ktb/db's generated schema re-exports
// this module, so a package-specifier import would cycle. The FK
// target is identical either way.
import { groups } from "../../groups/src/schema.ts";

/**
 * Machine registry (P-098 D1) — shells, VMs, GPU nodes and remote
 * endpoints that workloads (ACP agents, eval runners, transcription
 * adapters) can be scheduled onto.
 *
 * This table is a REGISTRY, not a connection: consumers resolve a
 * machine card and dial out through their own adapters (ssh/ws/child).
 * `secretRef` is a `vault:<id>` reference — auth material never lives
 * here. `capabilities` is a JSON array of workload kinds the machine
 * advertises ("acp", "eval-runner", "tts", "asr", "llm", …).
 *
 * Health: `lastSeenAt` is written by agent heartbeats (`beat`);
 * `lastCheckAt`/`checkError`/`status` by `check` probes (healthUrl
 * fetch or heartbeat-staleness derivation). No ACP/exec logic here.
 *
 * Scoping mirrors `vault_secret`: `scope` is `"platform"` (tenantId
 * NULL — shared machines, platform-admin managed) or the tenant id as
 * text; `tenantId` stays a real FK for cascade + queries.
 */
export const machine = sqliteTable(
	"machine",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** "platform" | String(tenantId) — the scope half of identity. */
		scope: text().notNull(),
		/** NULL = platform scope; set = owning clinic (groups.id). */
		tenantId: integer("tenant_id").references(() => groups.id, { onDelete: "cascade" }),
		/** Human label — unique per scope (e.g. "gpu-node-1", "dev-shell"). */
		name: text().notNull(),
		/** "shell" | "vm" | "gpu" | "endpoint" | "other". */
		kind: text().notNull().default("other"),
		host: text().notNull(),
		port: integer(),
		/** JSON array of advertised workload capabilities. */
		capabilities: text(),
		/** `vault:<id>` reference for machine auth material — never the material itself. */
		secretRef: text("secret_ref"),
		/** Optional HTTP health endpoint probed by `Machines.check`. */
		healthUrl: text("health_url"),
		/** "unknown" | "online" | "offline" | "draining" — last probe/heartbeat result. */
		status: text().notNull().default("unknown"),
		/** Last agent heartbeat ( Machines.beat ). */
		lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
		/** Last `check` probe timestamp. */
		lastCheckAt: integer("last_check_at", { mode: "timestamp_ms" }),
		/** Last probe failure detail (truncated, non-secret). */
		checkError: text("check_error"),
		enabled: integer().notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("machine_scope_name_idx").on(table.scope, table.name),
		index("machine_tenant_idx").on(table.tenantId),
		index("machine_status_idx").on(table.status),
	],
);
export type Machine = typeof machine.$inferSelect;
export type MachineKind = "shell" | "vm" | "gpu" | "endpoint" | "other";
export type MachineStatus = "unknown" | "online" | "offline" | "draining";
