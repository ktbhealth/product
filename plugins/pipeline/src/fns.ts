import { createServerFn } from "@tanstack/react-start";

import { Db } from "@ktb/db";
import {
	builtinKinds,
	getOrchestrationDef,
	listOrchestrationDefs,
	OrchestratorRegistry,
	upsertOrchestrationDef,
} from "@ktb/orchestrator";
import type { OrchestrationDefRecord } from "@ktb/orchestrator";
import { PlatformAdmin } from "@ktb/platform";
import { ensureSessionUser, getSessionUser, runAs } from "@ktb/server-fns";
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

/** Run `eff` as the session user after the PlatformAdmin gate. */
const asAdmin = <A, E>(
	user: { readonly id: string; readonly email?: string },
	eff: Effect.Effect<A, E, unknown>,
): Promise<A> =>
	runAs(
		user,
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			yield* platformAdmin.requireAdmin();
			return yield* eff;
		}),
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

export type { DataOnlyOrchestrationDef };
