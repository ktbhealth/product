import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm";

import type { DbClient, TxOp } from "@ktb/db";
import { tx } from "@ktb/db";
import {
	orchestrationDefs,
	orchestrationEvents,
	orchestrationNodeRuns,
	orchestrationRuns,
} from "../schema.ts";

import type { OrchestrationEvent, OrchestrationDef } from "../types.ts";
import type { OrchestrationSnapshot } from "../runner.ts";
import type { OrchestratorRegistryService } from "../registry.ts";
import type {
	LoadedOrchestrationRun,
	OrchestrationDefRecord,
	OrchestrationRunRecord,
	OrchestrationRunStatus,
	PendingEvent,
} from "./types.ts";

/**
 * store.ts — repo helpers over the `orchestration_*` tables
 * (../schema.ts). Follows the jobs-port precedent: plain async functions
 * taking `DbClient`, no service wrapper. JSON columns are plain `text`
 * in the schema; parse/serialize lives here so a corrupt row reads as
 * absent (`null`) instead of throwing inside drizzle.
 */

const stringify = (value: unknown): string => JSON.stringify(value);

/** Parse-or-null: corrupt JSON reads as absent — callers decide
 * whether that means "skip" (defs) or "fail the run" (runtime). */
const parseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
};

const parsePayload = (raw: string): OrchestrationEvent["payload"] => {
	const parsed = parseJson(raw);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as OrchestrationEvent["payload"])
		: {};
};

const toRunRecord = (row: typeof orchestrationRuns.$inferSelect): OrchestrationRunRecord => ({
	id: row.id,
	defId: row.defId,
	defVersion: row.defVersion,
	status: row.status as OrchestrationRunStatus,
	state: (parseJson(row.state) ?? {}) as OrchestrationRunRecord["state"],
	error: row.error,
	tenantId: row.tenantId,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const eventValues = (runId: string, seq: number, event: OrchestrationEvent) => ({
	runId,
	seq,
	eventId: event.id,
	eventType: event.type,
	payload: stringify(event.payload ?? {}),
	source: event.source,
	ts: event.ts,
	notBefore: event.notBefore ?? null,
});

const toEvent = (row: typeof orchestrationEvents.$inferSelect): OrchestrationEvent => ({
	type: row.eventType,
	payload: parsePayload(row.payload),
	source: row.source,
	id: row.eventId,
	ts: row.ts,
	...(row.notBefore === null ? {} : { notBefore: row.notBefore }),
});

// ---------------------------------------------------------------------------
// orchestration_defs
// ---------------------------------------------------------------------------

/**
 * Persist (or replace) an orchestration def. `version` falls back to
 * "1" when the def declares none. Defs with inline `handler` kinds are
 * rejected — functions cannot round-trip through JSON, and silently
 * dropping them would produce a def that fails kind resolution later.
 * On conflict only `version`/`def`/`updatedAt` move; `enabled` is
 * preserved so a disabled def stays disabled across redeploys.
 */
export const upsertOrchestrationDef = async (
	db: DbClient,
	def: OrchestrationDef,
	now = Date.now(),
): Promise<void> => {
	if (def.nodes.some((node) => node.handler !== undefined)) {
		throw new Error(
			`orchestration def ${def.id} has inline node handlers — persisted defs must be data-only (resolve kinds through the registry instead)`,
		);
	}
	const version = def.version ?? "1";
	const serialized = stringify(def);
	await db
		.insert(orchestrationDefs)
		.values({
			id: def.id,
			version,
			def: serialized,
			enabled: true,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: orchestrationDefs.id,
			set: { version, def: serialized, updatedAt: now },
		});
};

/** Row → record, or `null` when the stored def JSON is corrupt or
 * not def-shaped (treated as never-registered — the boot loader skips
 * poison rows rather than crashing on them). */
const toDefRecord = (row: typeof orchestrationDefs.$inferSelect): OrchestrationDefRecord | null => {
	const def = parseJson(row.def);
	if (typeof def !== "object" || def === null || !Array.isArray((def as OrchestrationDef).nodes)) {
		return null;
	}
	return {
		id: row.id,
		version: row.version,
		def: def as OrchestrationDef,
		enabled: row.enabled,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
};

/** Fetch one stored def; `null` when absent or the stored JSON is
 * corrupt. */
export const getOrchestrationDef = async (
	db: DbClient,
	id: string,
): Promise<OrchestrationDefRecord | null> => {
	const rows = await db
		.select()
		.from(orchestrationDefs)
		.where(eq(orchestrationDefs.id, id))
		.limit(1);
	const row = rows[0];
	return row === undefined ? null : toDefRecord(row);
};

/** List stored defs ordered by id. `enabledOnly` (default true)
 * filters out disabled rows — the boot loader's view. */
export const listOrchestrationDefs = async (
	db: DbClient,
	opts: { readonly enabledOnly?: boolean } = {},
): Promise<OrchestrationDefRecord[]> => {
	const enabledOnly = opts.enabledOnly ?? true;
	const rows = await db
		.select()
		.from(orchestrationDefs)
		.where(enabledOnly ? eq(orchestrationDefs.enabled, true) : undefined)
		.orderBy(asc(orchestrationDefs.id));
	const out: OrchestrationDefRecord[] = [];
	for (const row of rows) {
		const record = toDefRecord(row);
		if (record !== null) out.push(record);
	}
	return out;
};

/**
 * Boot-time def loader: registers every enabled stored def into the
 * in-memory {@link OrchestratorRegistryService}. Defs already
 * registered in-memory (code-registered at composition) win — stored
 * rows only fill gaps, so a redeploy cannot clobber a code def.
 * `registerDef` typed errors (UnknownKindError for a stored def whose
 * kind is not registered, DuplicateOrchestrationError on a race)
 * propagate — a stored def that cannot resolve is a boot failure, not
 * a silent skip. Returns the number of defs actually registered.
 */
export const loadStoredDefs = async (
	registry: OrchestratorRegistryService,
	db: DbClient,
): Promise<number> => {
	const rows = await listOrchestrationDefs(db, { enabledOnly: true });
	let loaded = 0;
	for (const row of rows) {
		if (registry.has(row.id)) continue;
		registry.registerDef(row.def);
		loaded += 1;
	}
	return loaded;
};

// ---------------------------------------------------------------------------
// orchestration_runs + orchestration_events + orchestration_node_runs
// ---------------------------------------------------------------------------

export interface CreateRunInput {
	readonly id: string;
	readonly defId: string;
	readonly defVersion: string;
	readonly snapshot: OrchestrationSnapshot;
	/** The run's initial queue event (seq 0) — `toInitialEvent(input)`
	 * from the caller so the stored row and a fresh session agree. */
	readonly initialEvent: OrchestrationEvent;
	/** Tenant scope stamped on the run row (`groups.id`); `null`/absent
	 * = platform/personal scope. */
	readonly tenantId?: number | null;
	readonly now?: number;
}

/** Insert a fresh run row plus its initial pending event, atomically
 * (one `tx` batch — a crash cannot leave a run without its seed
 * event). */
export const createOrchestrationRun = async (
	db: DbClient,
	input: CreateRunInput,
): Promise<void> => {
	const now = input.now ?? Date.now();
	await tx(db, [
		db.insert(orchestrationRuns).values({
			id: input.id,
			defId: input.defId,
			defVersion: input.defVersion,
			status: "running",
			state: stringify(input.snapshot.state),
			runtime: stringify(input.snapshot),
			error: null,
			tenantId: input.tenantId ?? null,
			createdAt: now,
			updatedAt: now,
		}),
		db.insert(orchestrationEvents).values(eventValues(input.id, 0, input.initialEvent)),
	]);
};

/** Public read: one run record by id (`null` when absent). The resume
 * payload stays internal — use {@link loadOrchestrationRun}. */
export const getOrchestrationRun = async (
	db: DbClient,
	id: string,
): Promise<OrchestrationRunRecord | null> => {
	const rows = await db
		.select()
		.from(orchestrationRuns)
		.where(eq(orchestrationRuns.id, id))
		.limit(1);
	const row = rows[0];
	return row === undefined ? null : toRunRecord(row);
};

/** Console-feed read: newest first. `tenantId` follows the
 * job-runs filter convention: absent = every scope, `null` = only
 * platform/personal (`tenant_id IS NULL`) rows, a number = that
 * tenant's runs. */
export const listOrchestrationRuns = async (
	db: DbClient,
	filter: {
		readonly defId?: string;
		readonly status?: OrchestrationRunStatus;
		readonly tenantId?: number | null;
		readonly limit?: number;
	} = {},
): Promise<OrchestrationRunRecord[]> => {
	const conditions: SQL[] = [];
	if (filter.defId !== undefined) conditions.push(eq(orchestrationRuns.defId, filter.defId));
	if (filter.status !== undefined) conditions.push(eq(orchestrationRuns.status, filter.status));
	if (filter.tenantId !== undefined) {
		conditions.push(
			filter.tenantId === null
				? isNull(orchestrationRuns.tenantId)
				: eq(orchestrationRuns.tenantId, filter.tenantId),
		);
	}
	const rows = await db
		.select()
		.from(orchestrationRuns)
		.where(conditions.length === 0 ? undefined : and(...conditions))
		.orderBy(desc(orchestrationRuns.createdAt), desc(orchestrationRuns.id))
		.limit(filter.limit ?? 100);
	return rows.map(toRunRecord);
};

/** The pending event queue for a run as {@link PendingEvent}s, in
 * `seq` (routing) order. */
export const listPendingEvents = async (db: DbClient, runId: string): Promise<PendingEvent[]> => {
	const rows = await db
		.select()
		.from(orchestrationEvents)
		.where(eq(orchestrationEvents.runId, runId))
		.orderBy(asc(orchestrationEvents.seq));
	return rows.map((row) => ({ runId: row.runId, seq: row.seq, event: toEvent(row) }));
};

/** Runner-facing load: run record + parsed runtime snapshot + pending
 * queue in one shot. `runtime` is `null` when the stored snapshot JSON
 * is corrupt — the runner fails the run instead of retrying poison. */
export const loadOrchestrationRun = async (
	db: DbClient,
	runId: string,
): Promise<LoadedOrchestrationRun | null> => {
	const [row, pending] = await Promise.all([
		db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runId)).limit(1),
		listPendingEvents(db, runId),
	]);
	const found = row[0];
	if (found === undefined) return null;
	const runtime = parseJson(found.runtime);
	return {
		record: toRunRecord(found),
		runtime:
			typeof runtime === "object" && runtime !== null ? (runtime as OrchestrationSnapshot) : null,
		pending,
	};
};

export interface SaveStepInput {
	readonly runId: string;
	/** The session's remaining queue — rewritten as the pending rows
	 * (delete-all + reinsert keeps `seq` positional and the write
	 * idempotent under step replay). Pass `[]` on terminal states. */
	readonly queue: readonly OrchestrationEvent[];
	readonly snapshot: OrchestrationSnapshot;
	readonly status: OrchestrationRunStatus;
	readonly now?: number;
}

/**
 * Persist one step boundary atomically (`tx` batch): rewrite the
 * pending-event queue, update the run row (status/state/runtime/
 * error), and append the not-yet-persisted trace tail to
 * `orchestration_node_runs`. Trace inserts upsert on (run_id, seq) so
 * a replayed step batch rewrites identical rows instead of
 * conflicting — the whole batch is atomic, so a mid-step crash leaves
 * the previous boundary intact and the job retry replays the batch.
 * The stored snapshot's `tracePersisted` advances to `trace.length`.
 */
export const saveOrchestrationStep = async (db: DbClient, input: SaveStepInput): Promise<void> => {
	const { runId, queue, snapshot, status } = input;
	const now = input.now ?? Date.now();
	const storedSnapshot: OrchestrationSnapshot = {
		...snapshot,
		tracePersisted: snapshot.trace.length,
	};
	const persisted = snapshot.tracePersisted;
	const ops = [
		db.delete(orchestrationEvents).where(eq(orchestrationEvents.runId, runId)),
		...queue.map((event, seq) =>
			db.insert(orchestrationEvents).values(eventValues(runId, seq, event)),
		),
		db
			.update(orchestrationRuns)
			.set({
				status,
				state: stringify(snapshot.state),
				runtime: stringify(storedSnapshot),
				error: snapshot.error ?? null,
				updatedAt: now,
			})
			.where(eq(orchestrationRuns.id, runId)),
		...snapshot.trace.slice(persisted).map((record, offset) => {
			const seq = persisted + offset;
			const values = {
				runId,
				seq,
				nodeId: record.nodeId,
				status: record.status,
				latencyMs: record.latencyMs,
				error: record.error ?? null,
				fires: record.fires,
			};
			return db
				.insert(orchestrationNodeRuns)
				.values(values)
				.onConflictDoUpdate({
					target: [orchestrationNodeRuns.runId, orchestrationNodeRuns.seq],
					set: {
						nodeId: values.nodeId,
						status: values.status,
						latencyMs: values.latencyMs,
						error: values.error,
						fires: values.fires,
					},
				});
		}),
	];
	// Heterogeneous op list built dynamically — the tuple constraint on
	// tx() only accepts literal tuples, so widen through TxOp[].
	await tx(db, ops as unknown as [TxOp, ...TxOp[]]);
};

/** Terminal failure without a session (def unresolvable, corrupt
 * runtime): mark the run failed, record the message, drop the pending
 * queue. Node trace rows already persisted stay — they are the audit
 * up to the failure. */
export const markOrchestrationRunFailed = async (
	db: DbClient,
	runId: string,
	error: string,
	now = Date.now(),
): Promise<void> => {
	await tx(db, [
		db.delete(orchestrationEvents).where(eq(orchestrationEvents.runId, runId)),
		db
			.update(orchestrationRuns)
			.set({ status: "failed", error, updatedAt: now })
			.where(eq(orchestrationRuns.id, runId)),
	]);
};

/** Node trace rows for a run, in `seq` order — the durable
 * NodeRunRecord audit. */
export const listNodeRuns = async (
	db: DbClient,
	runId: string,
): Promise<
	readonly {
		readonly seq: number;
		readonly nodeId: string;
		readonly status: string;
		readonly latencyMs: number;
		readonly error: string | null;
		readonly fires: number;
	}[]
> => {
	const rows = await db
		.select()
		.from(orchestrationNodeRuns)
		.where(eq(orchestrationNodeRuns.runId, runId))
		.orderBy(asc(orchestrationNodeRuns.seq));
	return rows.map((row) => ({
		seq: row.seq,
		nodeId: row.nodeId,
		status: row.status,
		latencyMs: row.latencyMs,
		error: row.error,
		fires: row.fires,
	}));
};
