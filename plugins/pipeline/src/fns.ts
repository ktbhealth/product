import { createServerFn } from "@tanstack/react-start";

import { Db } from "@ktb/db";
import {
	builtinKinds,
	getOrchestrationDef,
	getOrchestrationRun,
	listNodeRuns,
	listOrchestrationDefs,
	OrchestratorRegistry,
	upsertOrchestrationDef,
	type OrchestrationRunRecord,
} from "@ktb/orchestrator";
import type { OrchestrationDefRecord } from "@ktb/orchestrator";
import { PlatformAdmin } from "@ktb/platform";
import {
	ensureSessionUser,
	getSessionUser,
	getTenantSelector,
	runAs,
	runtimeProbe,
} from "@ktb/server-fns";
import { Tenant, tenantScopeId } from "@ktb/tenant";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Schema } from "effect";

import { decodeOrchestrationDef, type DataOnlyOrchestrationDef } from "./def-schema.ts";

/**
 * Pipeline admin server functions (P-120 phase 4): every handler is
 * PlatformAdmin-gated — the /platform layout already 404s non-admins,
 * and `requireAdmin` re-checks inside `runAs` (defense in depth, same
 * pattern as the plugin manager's fns). Def reads/writes go through
 * the @ktb/orchestrator durable-store helpers over `orchestration_defs`
 * — the same rows `loadStoredDefs` registers at boot, so an admin
 * upsert here is live after the next deploy/boot (and immediately for
 * any consumer that re-reads the table).
 */

/** Run `eff` as the session user after the PlatformAdmin gate.
 * `tenantSelector` (from `getTenantSelector`) is forwarded to `runAs`
 * so the composition root binds `Tenant` — fns that stamp or scope
 * by tenant pass it; the rest stay personal-scoped. */
const asAdmin = <A, E>(
	user: { readonly id: string; readonly email?: string },
	eff: Effect.Effect<A, E, unknown>,
	tenantSelector?: Parameters<typeof runAs>[2],
): Promise<A> =>
	runAs(
		user,
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			yield* platformAdmin.requireAdmin();
			return yield* eff;
		}),
		tenantSelector,
	);

/** `Forbidden` (and only it) collapses to the fn's denial value —
 * same translation the manager fns use. */
const isForbidden = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	(error as { _tag?: unknown })._tag === "Forbidden";

/** Serializable def record — `OrchestrationDefRecord` re-typed over the
 * data-only def (no `handler`), which is all a persisted row can
 * contain. Cast, not conversion: the store already guarantees the
 * shape (`upsertOrchestrationDef` rejects inline handlers and
 * `toDefRecord` only yields parsed JSON). */
export type OrchestrationDefRecordWire = Omit<OrchestrationDefRecord, "def"> & {
	readonly def: DataOnlyOrchestrationDef;
};

const asWireRecord = (record: OrchestrationDefRecord | null): OrchestrationDefRecordWire | null =>
	record === null ? null : (record as OrchestrationDefRecordWire);

/** Serializable list row — the table never needs the full def. */
export interface OrchestrationListRow {
	readonly id: string;
	readonly version: string;
	readonly description?: string;
	readonly nodeCount: number;
	readonly enabled: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Exported for the panel page loader — the table row is the same
 * wire shape whether it arrives via the fn or the loader. */
export const orchestrationListRow = (record: OrchestrationDefRecord): OrchestrationListRow => ({
	id: record.id,
	version: record.version,
	...(record.def.description === undefined ? {} : { description: record.def.description }),
	nodeCount: record.def.nodes.length,
	enabled: record.enabled,
	createdAt: record.createdAt,
	updatedAt: record.updatedAt,
});

/** Every stored orchestration def (enabled AND disabled — the admin
 * console manages both), newest fields first is NOT guaranteed: rows
 * come back id-ordered from the store. `null` for non-admins. */
export const listOrchestrationsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly OrchestrationListRow[] | null> => {
		const user = await getSessionUser();
		if (!user) return null;
		return asAdmin(
			user,
			Effect.gen(function* () {
				const db = yield* Db;
				const records = yield* Effect.promise(() =>
					listOrchestrationDefs(db, { enabledOnly: false }),
				);
				return records.map(orchestrationListRow);
			}),
		).catch((error: unknown) => {
			if (isForbidden(error)) return null;
			throw error;
		});
	},
);

const IdInput = Schema.NonEmptyString;
const decodeId = Schema.decodeUnknownSync(IdInput);

/** One stored def by id — the editor's load path. `null` for
 * non-admins and unknown ids (unknown reads as absent, same contract
 * as the store helper). */
export const getOrchestrationFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data: id }): Promise<OrchestrationDefRecordWire | null> => {
		const user = await getSessionUser();
		if (!user) return null;
		return asAdmin(
			user,
			Effect.gen(function* () {
				const db = yield* Db;
				return asWireRecord(yield* Effect.promise(() => getOrchestrationDef(db, id)));
			}),
		).catch((error: unknown) => {
			if (isForbidden(error)) return null;
			throw error;
		});
	});

/**
 * Persist (or replace) an orchestration def. The wire payload IS the
 * def — `def-schema.ts` validates the full `OrchestrationDef` shape
 * (including the data-only `handler: Never` rule) before the handler
 * runs; the durable store then rejects inline handlers a second time.
 * `version` falls back to "1" store-side when undeclared. Returns the
 * saved record summary; `false` for non-admins.
 */
export const upsertOrchestrationFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeOrchestrationDef(input))
	.handler(async ({ data: def }): Promise<OrchestrationDefRecordWire | false> => {
		const user = await ensureSessionUser();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const db = yield* Db;
				yield* Effect.promise(() => upsertOrchestrationDef(db, def));
				return asWireRecord(yield* Effect.promise(() => getOrchestrationDef(db, def.id))) ?? false;
			}),
		).catch((error: unknown) => {
			if (isForbidden(error)) return false;
			throw error;
		});
	});

/**
 * Kind ids the node palette offers: the live `OrchestratorRegistry`
 * when the composition root provides one, `builtinKinds` otherwise —
 * the registry is not yet wired into every runtime, and an admin
 * editor must still offer the shipped kinds. Sorted for a stable
 * palette.
 */
export const listOrchestrationKindsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly string[] | null> => {
		const user = await getSessionUser();
		if (!user) return null;
		return asAdmin(
			user,
			Effect.gen(function* () {
				const registry = yield* Effect.serviceOption(OrchestratorRegistry);
				const kinds = Option.isSome(registry)
					? registry.value.listKinds().map((kind) => kind.id)
					: builtinKinds.map((kind) => kind.id);
				return [...new Set(kinds)].sort();
			}),
		).catch((error: unknown) => {
			if (isForbidden(error)) return null;
			throw error;
		});
	},
);

// ---------------------------------------------------------------------------
// Durable runs (P-120 phase 2): start + inspect. Defs stay GLOBAL
// composition data, but runs carry `orchestration_runs.tenant_id` —
// stamped from the bound `Tenant` at start (NULL = platform/personal
// scope, same convention as job_runs) and propagated onto every
// `orchestrator.step` envelope so durable steps re-bind tenant scope.
// Reads stay admin-cross-tenant: the PlatformAdmin gate is the whole
// auth boundary (same convention as Audit.adminList / the queue
// console's jobRuns — admin sees every tenant's rows). `start` reaches
// the durable runner through the ServerRuntime `orchestration`
// capability the composition root wires when the jobs transport is
// bound; without it the fn reports unavailable instead of enqueuing
// into the void.
// ---------------------------------------------------------------------------

const StartOrchestrationInput = Schema.Struct({
	defId: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Unknown),
});
const decodeStartOrchestrationInput = Schema.decodeUnknownSync(StartOrchestrationInput);

export type StartOrchestrationResult =
	| { readonly ok: true; readonly runId: string }
	| { readonly ok: false; readonly error: string }
	| false;

/** Failure text for the `{ok:false}` wire — OrchestratorError tagged
 * errors carry `message`; anything else degrades to String(). */
const describeRunError = (error: unknown): string =>
	error instanceof Error && error.message !== "" ? error.message : String(error);

/**
 * Start a durable orchestration run: persists the run row + seed event
 * and enqueues the first `orchestrator.step` job (the queue consumer
 * drives the rest). `input` is the run's initial-event payload —
 * JSON-serializable data only; live functions cannot cross the
 * durable boundary (bind ports via the runner's ambientContext at the
 * composition root instead). Returns `{ok:true, runId}`; `{ok:false}`
 * for unknown defs / runner failures; `false` for non-admins.
 */
export const startOrchestrationFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeStartOrchestrationInput(input))
	.handler(async ({ data }): Promise<StartOrchestrationResult> => {
		const user = await ensureSessionUser();
		const tenantSelector = await getTenantSelector();
		return asAdmin(
			user,
			Effect.gen(function* () {
				const startRun = runtimeProbe((r) => r.orchestration?.startRun);
				if (startRun === undefined) {
					return {
						ok: false as const,
						error: "orchestration runner unavailable (jobs transport unbound)",
					};
				}
				// Stamp the run with the request's tenant scope — NULL in
				// personal/platform scope (the /platform console normally
				// sends no tenant selector, so admin-started runs are
				// global unless a tenant context is bound).
				const tenantId = tenantScopeId(yield* Tenant);
				return yield* Effect.tryPromise({
					try: () => startRun(data.defId, data.input, tenantId),
					catch: (error) => error,
				}).pipe(
					Effect.map((runId): StartOrchestrationResult => ({ ok: true, runId })),
					Effect.catch((error): Effect.Effect<StartOrchestrationResult> =>
						Effect.succeed({ ok: false, error: describeRunError(error) }),
					),
				);
			}),
			tenantSelector,
		).catch((error: unknown) => {
			if (isForbidden(error)) return false;
			throw error;
		});
	});

/** Serializable run view — `OrchestrationRunRecord` plus the durable
 * node-run trace tail (`orchestration_node_runs`). `state` is the
 * merged node-state JsonObject; both are JSON-safe by construction. */
export type OrchestrationRunWire = OrchestrationRunRecord & {
	readonly nodeRuns: readonly {
		readonly seq: number;
		readonly nodeId: string;
		readonly status: string;
		readonly latencyMs: number;
		readonly error: string | null;
		readonly fires: number;
	}[];
};

/** One durable run by id — status, merged state, error, tenant scope
 * and the node trace. Admin-cross-tenant like every read in this file
 * (PlatformAdmin sees all tenants' runs; `tenantId` on the record is
 * attribution, not a fence). `null` for non-admins and unknown ids
 * (same absent-reads-as-null contract as getOrchestrationFn). */
export const getOrchestrationRunFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeId(input))
	.handler(async ({ data: runId }): Promise<OrchestrationRunWire | null> => {
		const user = await getSessionUser();
		if (!user) return null;
		return asAdmin(
			user,
			Effect.gen(function* () {
				const db = yield* Db;
				const record = yield* Effect.promise(() => getOrchestrationRun(db, runId));
				if (record === null) return null;
				const nodeRuns = yield* Effect.promise(() => listNodeRuns(db, runId));
				return { ...record, nodeRuns };
			}),
		).catch((error: unknown) => {
			if (isForbidden(error)) return null;
			throw error;
		});
	});
