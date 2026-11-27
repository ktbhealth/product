import type { OrchestrationDef, OrchestrationEvent, JsonObject } from "../types.ts";
import type { OrchestrationSnapshot } from "../runner.ts";

/**
 * types.ts — durable-run record shapes (phase 2). These mirror the
 * `orchestration_*` tables in `@ktb/db`; the store helpers in
 * `store.ts` own the row ↔ record mapping.
 */

/** Run lifecycle: "running" while step jobs advance it; the other
 * three are terminal (mirrors `OrchestrationRunResult.status` plus the
 * pre-result "running" state). */
export type OrchestrationRunStatus = "running" | "done" | "failed" | "cancelled";

/** Public read shape of an `orchestration_runs` row. `state` is the
 * merged node-state object; `error` is the run-level failure message
 * (NULL unless status = "failed"). The resume payload (`runtime`)
 * stays internal to the runner — callers wanting it use
 * `loadOrchestrationRun`. */
export interface OrchestrationRunRecord {
	readonly id: string;
	readonly defId: string;
	readonly defVersion: string;
	readonly status: OrchestrationRunStatus;
	readonly state: JsonObject;
	readonly error: string | null;
	/** Tenant scope (`groups.id`) the run was started under; `null` =
	 * platform/personal scope (same convention as `job_runs.tenant_id`). */
	readonly tenantId: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** A run row plus everything the durable runner needs to resume it:
 * the parsed {@link OrchestrationSnapshot} (`null` when the stored
 * JSON is corrupt — the runner fails the run rather than retrying a
 * poison payload forever) and the pending event queue in `seq` order. */
export interface LoadedOrchestrationRun {
	readonly record: OrchestrationRunRecord;
	readonly runtime: OrchestrationSnapshot | null;
	readonly pending: readonly PendingEvent[];
}

/** Public read shape of an `orchestration_defs` row. */
export interface OrchestrationDefRecord {
	readonly id: string;
	readonly version: string;
	readonly def: OrchestrationDef;
	readonly enabled: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** One pending (not yet processed) event for a run — the durable form
 * of the session's in-memory queue. `seq` is the positional queue
 * index, rewritten at every step boundary. */
export interface PendingEvent {
	readonly runId: string;
	readonly seq: number;
	readonly event: OrchestrationEvent;
}
