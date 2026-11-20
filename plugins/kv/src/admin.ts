import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";

import { Forbidden } from "@ktb/authz";
import { Db } from "@ktb/db";
import { PlatformAdmin } from "@ktb/platform";

import { kvEntries, type KvEntryRow } from "./schema.ts";
import {
	findRow,
	isExpired,
	MAX_FIELD_LENGTH,
	normalizeTenantId,
	serialize,
	sliceWhere,
	validateField,
	validateKey,
	validateTtl,
	KvConflictError,
	KvNotFoundError,
	KvValidationError,
	type ResolvedScope,
} from "./service.ts";

/**
 * KvAdmin — the platform-admin read/write surface over `kv_entries`
 * (P-090 console, mirrors `Pages.admin*`). Every method re-checks
 * the `PlatformAdmin` gate inside the service (defense in depth — the
 * /platform layout, page guard and server fns gate too). Unlike `Kv`,
 * there is NO tenant/owner fencing: a platform admin is
 * deployment-global and sees every scope slice, including expired rows
 * (flagged `expired` — dead rows stay admin-visible until
 * `Kv.sweepExpired` or a lazy delete removes them).
 *
 * Scope input (`KvAdminScope`) is literal like `KvScope`: omitted
 * fields mean NULL (global), NOT "inherit from context". A non-NULL
 * `tenantId` drops `ownerId` (tenant rows are shared — same rule as
 * `Kv`).
 *
 * `set` differs from `Kv.set` in two deliberate ways:
 * - `ttlMs` absent PRESERVES the stored expiry on a live row (edit
 *   semantics — the console edits values, not deadlines, unless asked);
 *   `ttlMs: null` clears it, a number sets a fresh TTL from now. An
 *   expired (logically absent) row preserves nothing — it revives
 *   with no expiry unless `ttlMs` is given.
 * - `expectedVersion` gives the same CAS guard as `Kv.set`
 *   (`KvConflictError` on mismatch, `KvNotFoundError` when the slice
 *   is absent or already expired).
 *
 * Namespace `registerSchema` validators are NOT consulted — admins
 * override plugin-registered shapes deliberately (documented escape
 * hatch; the stored value must still be valid JSON).
 */

// ---------- wire types ----------

/** Explicit scope slice for admin targeting — see module doc. */
export interface KvAdminScope {
	readonly tenantId?: number | string | null;
	readonly ownerId?: string | null;
}

/** Row identity for get/remove/set: namespace+key+scope slice. */
export interface KvAdminTarget extends KvAdminScope {
	readonly namespace: string;
	readonly key: string;
}

/** A stored entry as the console sees it: decoded JSON value plus row
 * metadata. `expired` marks rows past `expiresAt` (still stored —
 * lazy-delete only happens through `Kv` reads or `sweepExpired`). */
export interface KvAdminEntry {
	readonly namespace: string;
	readonly key: string;
	readonly tenantId: number | null;
	readonly ownerId: string | null;
	readonly value: unknown;
	readonly version: number;
	readonly expiresAt: number | null;
	readonly expired: boolean;
}

export interface KvAdminFilter {
	/** Exact namespace match; absent/empty = all namespaces. */
	readonly namespace?: string;
	/** Key prefix filter (instr-equality, same as `Kv.keys`). */
	readonly prefix?: string;
	/** Page size — clamped to [1, MAX_ADMIN_LIMIT], default
	 * DEFAULT_ADMIN_LIMIT. */
	readonly limit?: number;
	/** Row offset for pagination (>= 0). */
	readonly offset?: number;
}

export interface KvAdminList {
	readonly items: readonly KvAdminEntry[];
	readonly total: number;
}

export interface KvAdminNamespaceCount {
	readonly namespace: string;
	readonly count: number;
}

export interface KvAdminSetInput extends KvAdminTarget {
	/** Any JSON-serializable value — serialized like `Kv.set`. */
	readonly value: unknown;
	/** undefined = preserve stored expiry; null = clear; number = TTL
	 * in ms from now. */
	readonly ttlMs?: number | null;
	/** CAS guard — same contract as `KvSetOptions.expectedVersion`. */
	readonly expectedVersion?: number;
}

export type KvAdminError = Forbidden | KvValidationError | KvConflictError | KvNotFoundError;

export const DEFAULT_ADMIN_LIMIT = 50;
export const MAX_ADMIN_LIMIT = 200;

// ---------- scope normalization ----------

const normalizeOwnerId = (
	ownerId: string | null | undefined,
): Effect.Effect<string | null, KvValidationError> => {
	if (ownerId === null || ownerId === undefined || ownerId === "") {
		return Effect.succeed(null);
	}
	if (typeof ownerId !== "string" || ownerId.length > MAX_FIELD_LENGTH) {
		return Effect.fail(
			new KvValidationError({
				reason: `ownerId must be a string of at most ${MAX_FIELD_LENGTH} characters`,
			}),
		);
	}
	return Effect.succeed(ownerId);
};

/** Literal scope resolution — no context fallback (admin targets a
 * slice explicitly). Mirrors `Kv.resolveScope`'s tenant-drops-owner
 * rule. */
const normalizeScope = (
	scope: KvAdminScope | undefined,
): Effect.Effect<ResolvedScope, KvValidationError> =>
	Effect.gen(function* () {
		const tenantId = yield* normalizeTenantId(scope?.tenantId);
		const ownerId = yield* normalizeOwnerId(scope?.ownerId);
		return { tenantId, ownerId: tenantId !== null ? null : ownerId };
	});

// ---------- row access ----------

/** Decode `row.value` defensively — the service only writes valid
 * JSON, but an admin surface shouldn't 500 on a hand-edited row. */
const decodeValue = (raw: string): unknown => {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return raw;
	}
};

const toAdminEntry = (row: KvEntryRow, now: number): KvAdminEntry => ({
	namespace: row.namespace,
	key: row.key,
	tenantId: row.tenantId,
	ownerId: row.ownerId,
	value: decodeValue(row.value),
	version: row.version,
	expiresAt: row.expiresAt,
	expired: isExpired(row, now),
});

// ---------- service ----------

export interface KvAdminShape {
	/** Bounded, filterable listing across ALL namespaces/scopes —
	 * expired rows included (flagged). */
	readonly list: (filter?: KvAdminFilter) => Effect.Effect<KvAdminList, KvAdminError>;
	/** Per-namespace row counts, ordered by namespace. */
	readonly namespaces: () => Effect.Effect<readonly KvAdminNamespaceCount[], Forbidden>;
	/** One slice's entry (expired included), or null when absent. */
	readonly get: (target: KvAdminTarget) => Effect.Effect<KvAdminEntry | null, KvAdminError>;
	/** Upsert (or CAS-guarded update) a slice's value. */
	readonly set: (input: KvAdminSetInput) => Effect.Effect<KvAdminEntry, KvAdminError>;
	/** Delete a slice's row — expired rows count as removed. */
	readonly remove: (target: KvAdminTarget) => Effect.Effect<boolean, KvAdminError>;
}

export class KvAdmin extends Context.Service<KvAdmin, KvAdminShape>()("@ktb/kv/KvAdmin") {}

export const KvAdminLive = Layer.effect(
	KvAdmin,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		const requireAdmin = platformAdmin.requireAdmin();

		return {
			list: (filter) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					const namespace = filter?.namespace;
					if (namespace !== undefined && namespace !== "") {
						const bad = validateField("namespace", namespace);
						if (bad !== null) return yield* Effect.fail(bad);
					}
					const prefix = filter?.prefix;
					if (prefix !== undefined && prefix !== "") {
						const bad = validateField("prefix", prefix);
						if (bad !== null) return yield* Effect.fail(bad);
					}
					if (
						filter?.limit !== undefined &&
						(!Number.isInteger(filter.limit) || filter.limit < 1)
					) {
						return yield* Effect.fail(
							new KvValidationError({ reason: "limit must be a positive integer" }),
						);
					}
					if (
						filter?.offset !== undefined &&
						(!Number.isInteger(filter.offset) || filter.offset < 0)
					) {
						return yield* Effect.fail(
							new KvValidationError({ reason: "offset must be a non-negative integer" }),
						);
					}
					const limit = Math.min(filter?.limit ?? DEFAULT_ADMIN_LIMIT, MAX_ADMIN_LIMIT);
					const offset = filter?.offset ?? 0;

					const conds: (SQL | undefined)[] = [];
					if (namespace !== undefined && namespace !== "") {
						conds.push(eq(kvEntries.namespace, namespace));
					}
					if (prefix !== undefined && prefix !== "") {
						// instr-equality instead of LIKE — prefix needs no
						// escaping (same approach as `Kv.keys`).
						conds.push(sql`instr(${kvEntries.key}, ${prefix}) = 1`);
					}
					const where = and(...conds);
					const now = Date.now();
					const [rows, totals] = yield* Effect.all([
						Effect.promise(() =>
							db
								.select()
								.from(kvEntries)
								.where(where)
								.orderBy(
									asc(kvEntries.namespace),
									asc(kvEntries.key),
									asc(kvEntries.tenantId),
									asc(kvEntries.ownerId),
								)
								.limit(limit)
								.offset(offset),
						),
						Effect.promise(() =>
							db
								.select({ n: sql<number>`count(*)` })
								.from(kvEntries)
								.where(where),
						),
					]);
					return {
						items: rows.map((row) => toAdminEntry(row, now)),
						// count(*) always yields one row — the fallback is defensive.
						/* v8 ignore next -- unreachable: count(*) returns a row */
						total: totals[0]?.n ?? 0,
					};
				}),

			namespaces: () =>
				Effect.gen(function* () {
					yield* requireAdmin;
					const rows = yield* Effect.promise(() =>
						db
							.select({ namespace: kvEntries.namespace, n: sql<number>`count(*)` })
							.from(kvEntries)
							.groupBy(kvEntries.namespace)
							.orderBy(asc(kvEntries.namespace)),
					);
					return rows.map((r) => ({ namespace: r.namespace, count: r.n }));
				}),

			get: (target) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					yield* validateKey(target.namespace, target.key);
					const scope = yield* normalizeScope(target);
					const row = yield* Effect.promise(() => findRow(db, target.namespace, target.key, scope));
					return row === null ? null : toAdminEntry(row, Date.now());
				}),

			set: (input) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					yield* validateKey(input.namespace, input.key);
					const scope = yield* normalizeScope(input);
					const serialized = yield* serialize(input.value);
					const now = Date.now();

					const existing = yield* Effect.promise(() =>
						findRow(db, input.namespace, input.key, scope),
					);
					const live = existing !== null && !isExpired(existing, now) ? existing : null;

					// ttlMs: undefined preserves the LIVE row's deadline (an
					// expired row revives with none), null clears, a number
					// sets a fresh TTL from now.
					const expiresAt =
						input.ttlMs === undefined
							? (live?.expiresAt ?? null)
							: input.ttlMs === null
								? null
								: yield* validateTtl(input.ttlMs, now);

					if (input.expectedVersion !== undefined) {
						const expected = input.expectedVersion;
						if (!Number.isInteger(expected) || expected < 1) {
							return yield* Effect.fail(
								new KvValidationError({
									reason: "expectedVersion must be a positive integer",
								}),
							);
						}
						if (existing !== null && isExpired(existing, now)) {
							// Align with Kv.set: an already-expired row is
							// logically absent — remove it, then report
							// NotFound below.
							yield* Effect.promise(() =>
								db.delete(kvEntries).where(eq(kvEntries.id, existing.id)),
							);
						}
						let updated: KvEntryRow | undefined;
						if (live !== null) {
							const rows = yield* Effect.promise(() =>
								db
									.update(kvEntries)
									.set({
										value: serialized,
										expiresAt,
										version: sql`${kvEntries.version} + 1`,
										updatedAt: new Date(now),
									})
									.where(
										and(
											eq(kvEntries.id, live.id),
											eq(kvEntries.version, expected),
											or(isNull(kvEntries.expiresAt), gt(kvEntries.expiresAt, now)),
										),
									)
									.returning(),
							);
							updated = rows[0];
						}
						if (updated !== undefined) return toAdminEntry(updated, now);
						const current = yield* Effect.promise(() =>
							findRow(db, input.namespace, input.key, scope),
						);
						if (current === null || isExpired(current, now)) {
							return yield* Effect.fail(
								new KvNotFoundError({
									namespace: input.namespace,
									key: input.key,
								}),
							);
						}
						return yield* Effect.fail(
							new KvConflictError({
								namespace: input.namespace,
								key: input.key,
								expectedVersion: expected,
								actualVersion: current.version,
							}),
						);
					} else {
						const [row] = yield* Effect.promise(() =>
							db
								.insert(kvEntries)
								.values({
									namespace: input.namespace,
									key: input.key,
									tenantId: scope.tenantId,
									ownerId: scope.ownerId,
									value: serialized,
									expiresAt,
									version: 1,
									createdAt: new Date(now),
									updatedAt: new Date(now),
								})
								.onConflictDoUpdate({
									target: [
										kvEntries.namespace,
										kvEntries.key,
										kvEntries.tenantKey,
										kvEntries.ownerKey,
									],
									set: {
										value: serialized,
										expiresAt,
										version: sql`${kvEntries.version} + 1`,
										updatedAt: new Date(now),
									},
								})
								.returning(),
						);
						return toAdminEntry(row!, now);
					}
				}),

			remove: (target) =>
				Effect.gen(function* () {
					yield* requireAdmin;
					yield* validateKey(target.namespace, target.key);
					const scope = yield* normalizeScope(target);
					const rows = yield* Effect.promise(() =>
						db
							.delete(kvEntries)
							.where(sliceWhere(target.namespace, target.key, scope))
							.returning({ id: kvEntries.id }),
					);
					return rows.length > 0;
				}),
		};
	}),
);
