import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { accessibleTenantIds, Tenant, tenantScopeId } from "@ktb/tenant";

import { kvEntries, type KvEntryRow } from "./schema.ts";

/**
 * Kv — the TTL'd, namespaced key/value state service (P-090). Plugins
 * use it for durable small state (cursors, flags, counters, cached
 * lookups) instead of growing bespoke tables. Values are JSON; each
 * entry additionally carries a scope slice (`tenantId`/`ownerId`, see
 * schema.ts) so the same key can hold per-tenant or per-user state.
 *
 * Scope resolution (`KvScope`): when `scope` is omitted the slice is
 * derived from the request context — the bound `Tenant` (via
 * `tenantScopeId`) and the bound `Principal`'s userId as owner — so a
 * plugin calling `kv.get("ns","k")` in a request reads that user's
 * personal row, while system flows (jobs, webhooks, `TenantAccess`-
 * bound batch work) resolve to global or explicitly-scoped slices.
 * When `scope` IS provided it is taken literally: missing fields mean
 * NULL (global), NOT "inherit from context" — pass
 * `{ tenantId: 5 }` for a tenant slice, `{ ownerId: "u1" }` for a
 * personal slice, `{}` for the global slice. Tenant-owned rows never
 * carry `owner_id` (owner scoping is personal-only), so an explicit
 * `ownerId` alongside `tenantId` is ignored.
 *
 * Fencing mirrors the patients plugin (P-053-B): a non-NULL resolved
 * `tenantId` must be in the caller's accessible tenant set
 * (`Tenant`/`TenantAccess` — `accessibleTenantIds`), otherwise the
 * call fails `Forbidden`; a personal-scope `ownerId` that differs from
 * the bound principal's userId also fails `Forbidden` (system flows
 * with no principal are trusted — plugins are the authz boundary).
 * Note `tenantScopeId` only yields an integer tenant id — a tenant
 * whose `id` is non-numeric resolves to `null`, i.e. the personal
 * (or global, when no principal is bound) slice.
 *
 * TTL: `expires_at` is epoch ms; reads treat expired rows as absent
 * (lazy delete), `sweepExpired()` bulk-removes them, and `expire()`
 * sets/refreshes the deadline on a live row (already-expired rows are
 * lazily deleted and report `false`; like `delete`, `expire()` bumps
 * `updated_at` but NOT `version` — a TTL-only change is invisible to
 * CAS guards). `set()` without `ttlMs` clears any existing expiry
 * (Redis SET semantics); `increment()` preserves a live TTL and
 * applies `ttlMs` only when given.
 *
 * `registerSchema` validators are consulted by `set`/`setIfAbsent`
 * only. `increment`, `expire`, `delete`, `keys` and `sweepExpired`
 * bypass them by design: `increment` operates on the numeric-counter
 * shape (and enforces that itself via `KvTypeError`), while the rest
 * don't write values at all. A namespace that registers a schema
 * shouldn't rely on bare `increment` for its value shape.
 */

// ---------- errors ----------

export class KvValidationError extends Data.TaggedError("KvValidationError")<{
	readonly reason: string;
}> {}

export class KvConflictError extends Data.TaggedError("KvConflictError")<{
	readonly namespace: string;
	readonly key: string;
	readonly expectedVersion: number;
	readonly actualVersion: number | null;
}> {}

export class KvNotFoundError extends Data.TaggedError("KvNotFoundError")<{
	readonly namespace: string;
	readonly key: string;
}> {}

export class KvTypeError extends Data.TaggedError("KvTypeError")<{
	readonly namespace: string;
	readonly key: string;
	readonly reason: string;
}> {}

export type KvError =
	| KvValidationError
	| KvConflictError
	| KvNotFoundError
	| KvTypeError
	| Forbidden;

// ---------- wire types ----------

/** Explicit scope slice. See the module doc for resolution rules. */
export interface KvScope {
	readonly tenantId?: number | string | null;
	readonly ownerId?: string | null;
}

export interface KvSetOptions {
	/** TTL in milliseconds from now; absent clears any existing expiry. */
	readonly ttlMs?: number;
	readonly scope?: KvScope;
	/** CAS guard: the write only lands when the stored row's `version`
	 * equals this value. Missing row → `KvNotFoundError`; version
	 * mismatch → `KvConflictError`. */
	readonly expectedVersion?: number;
}

export interface KvKeysOptions {
	/** Only return keys starting with this prefix. */
	readonly prefix?: string;
	/** Page size — clamped to [1, MAX_KEYS_LIMIT], default DEFAULT_KEYS_LIMIT. */
	readonly limit?: number;
}

/** A stored entry as returned by `get`/`set`: the JSON-decoded value
 * plus row metadata. `expiresAt` is epoch ms (null = never). */
export interface KvEntry<T = unknown> {
	readonly namespace: string;
	readonly key: string;
	readonly value: T;
	readonly version: number;
	readonly expiresAt: number | null;
	readonly tenantId: number | null;
	readonly ownerId: string | null;
}

export interface KvShape {
	readonly get: <T = unknown>(
		namespace: string,
		key: string,
		scope?: KvScope,
	) => Effect.Effect<KvEntry<T> | null, KvError>;
	readonly set: (
		namespace: string,
		key: string,
		value: unknown,
		options?: KvSetOptions,
	) => Effect.Effect<KvEntry, KvError>;
	readonly setIfAbsent: (
		namespace: string,
		key: string,
		value: unknown,
		options?: Omit<KvSetOptions, "expectedVersion">,
	) => Effect.Effect<boolean, KvError>;
	readonly delete: (
		namespace: string,
		key: string,
		scope?: KvScope,
	) => Effect.Effect<boolean, KvError>;
	readonly increment: (
		namespace: string,
		key: string,
		by?: number,
		options?: Omit<KvSetOptions, "expectedVersion">,
	) => Effect.Effect<number, KvError>;
	readonly expire: (
		namespace: string,
		key: string,
		ttlMs: number,
		scope?: KvScope,
	) => Effect.Effect<boolean, KvError>;
	readonly keys: (
		namespace: string,
		scope?: KvScope,
		options?: KvKeysOptions,
	) => Effect.Effect<readonly string[], KvError>;
	/** Delete every expired row across all namespaces/scopes — a
	 * maintenance op, intentionally NOT scope-fenced (dead rows carry
	 * no live data). Returns the number of rows removed. */
	readonly sweepExpired: () => Effect.Effect<number, KvError>;
	/** Register a per-namespace validator consulted on `set`/`setIfAbsent`.
	 * Minimal by design: a synchronous predicate over the decoded value —
	 * consumers wanting effect/Schema can wrap `Schema.is` themselves.
	 * `increment`/`expire`/`delete`/`keys`/`sweepExpired` bypass it (see
	 * module doc). Registrations are per-layer (per isolate). */
	readonly registerSchema: (
		namespace: string,
		validate: (value: unknown) => boolean,
	) => Effect.Effect<void, KvValidationError>;
}

export class Kv extends Context.Service<Kv, KvShape>()("@ktb/kv/Kv") {}

// ---------- validation helpers ----------

export const MAX_FIELD_LENGTH = 200;
export const DEFAULT_KEYS_LIMIT = 200;
export const MAX_KEYS_LIMIT = 1000;

export const validateField = (field: string, value: string): KvValidationError | null =>
	value.length === 0 || value.length > MAX_FIELD_LENGTH
		? new KvValidationError({
				reason: `${field} must be 1..${MAX_FIELD_LENGTH} characters`,
			})
		: null;

export const validateKey = (namespace: string, key: string) =>
	Effect.gen(function* () {
		const bad = validateField("namespace", namespace) ?? validateField("key", key);
		if (bad !== null) return yield* Effect.fail(bad);
	});

const validateNamespace = (namespace: string) =>
	Effect.gen(function* () {
		const bad = validateField("namespace", namespace);
		if (bad !== null) return yield* Effect.fail(bad);
	});

export const validateTtl = (ttlMs: number, now: number) => {
	const expiresAt = now + ttlMs;
	// `now + ttlMs` can only reach Infinity for ttlMs values already
	// rejected below (non-finite) — this overflow guard is defensive.
	/* v8 ignore next 3 -- unreachable: a finite ttlMs cannot overflow now+ttlMs */
	if (!Number.isFinite(expiresAt)) {
		return Effect.fail(new KvValidationError({ reason: "ttlMs must be a positive finite number" }));
	}
	return ttlMs > 0
		? Effect.succeed(expiresAt)
		: Effect.fail(new KvValidationError({ reason: "ttlMs must be a positive finite number" }));
};

/** JSON-serialize a value; rejects non-JSON shapes (undefined,
 * functions, symbols, bigint, circular refs, top-level non-finite
 * numbers). Nested non-finite numbers degrade to `null` per JSON
 * semantics — same as JSON.stringify everywhere else. */
export const serialize = (value: unknown): Effect.Effect<string, KvValidationError> => {
	if (typeof value === "number" && !Number.isFinite(value)) {
		return Effect.fail(
			new KvValidationError({ reason: "value must be JSON-serializable (non-finite number)" }),
		);
	}
	let out: string | undefined;
	try {
		out = JSON.stringify(value);
	} catch {
		return Effect.fail(
			new KvValidationError({
				reason: "value must be JSON-serializable (circular or unsupported)",
			}),
		);
	}
	return typeof out === "string"
		? Effect.succeed(out)
		: Effect.fail(
				new KvValidationError({
					reason: "value must be JSON-serializable (undefined/function/symbol)",
				}),
			);
};

// ---------- scope resolution + fencing ----------

export interface ResolvedScope {
	readonly tenantId: number | null;
	readonly ownerId: string | null;
}

export const normalizeTenantId = (
	id: number | string | null | undefined,
): Effect.Effect<number | null, KvValidationError> => {
	if (id === null || id === undefined) return Effect.succeed(null);
	if (typeof id === "number") {
		return Number.isInteger(id)
			? Effect.succeed(id)
			: Effect.fail(new KvValidationError({ reason: "tenantId must be an integer" }));
	}
	if (typeof id !== "string") {
		return Effect.fail(
			new KvValidationError({ reason: "tenantId must be a number or numeric string" }),
		);
	}
	const trimmed = id.trim();
	if (trimmed === "") return Effect.succeed(null);
	if (!/^-?\d+$/.test(trimmed)) {
		return Effect.fail(new KvValidationError({ reason: "tenantId must be numeric" }));
	}
	return Effect.succeed(Number(trimmed));
};

const resolveScope = (scope?: KvScope): Effect.Effect<ResolvedScope, KvValidationError> =>
	Effect.gen(function* () {
		let tenantId: number | null;
		let ownerId: string | null;
		if (scope !== undefined) {
			tenantId = yield* normalizeTenantId(scope.tenantId);
			const rawOwner = scope.ownerId;
			if (rawOwner !== null && rawOwner !== undefined) {
				if (typeof rawOwner !== "string" || rawOwner.length > MAX_FIELD_LENGTH) {
					return yield* Effect.fail(
						new KvValidationError({
							reason: `ownerId must be a string of at most ${MAX_FIELD_LENGTH} characters`,
						}),
					);
				}
			}
			ownerId = rawOwner === null || rawOwner === undefined || rawOwner === "" ? null : rawOwner;
		} else {
			tenantId = tenantScopeId(yield* Tenant);
			ownerId = (yield* Principal)?.userId ?? null;
		}
		// Tenant-owned rows are shared: owner scoping is personal-only, so
		// an explicit ownerId next to tenantId is dropped (documented on
		// KvScope). This also keeps tenant rows unique per (ns,key,tenant).
		if (tenantId !== null) ownerId = null;
		return { tenantId, ownerId };
	});

/** Tenant membership + personal-owner fence (see module doc). */
const assertScope = (scope: ResolvedScope): Effect.Effect<void, Forbidden> =>
	Effect.gen(function* () {
		if (scope.tenantId !== null) {
			const ids = yield* accessibleTenantIds;
			if (!ids.some((id) => Number(id) === scope.tenantId)) {
				return yield* Effect.fail(new Forbidden({ path: "kv.scope" }));
			}
			return;
		}
		if (scope.ownerId !== null) {
			const principal = yield* Principal;
			if (principal !== null && principal.userId !== scope.ownerId) {
				return yield* Effect.fail(new Forbidden({ path: "kv.scope" }));
			}
		}
	});

// ---------- row access ----------

export type Row = KvEntryRow;

export const sliceWhere = (namespace: string, key: string, scope: ResolvedScope): SQL | undefined =>
	and(
		eq(kvEntries.namespace, namespace),
		eq(kvEntries.key, key),
		scope.tenantId === null ? isNull(kvEntries.tenantId) : eq(kvEntries.tenantId, scope.tenantId),
		scope.ownerId === null ? isNull(kvEntries.ownerId) : eq(kvEntries.ownerId, scope.ownerId),
	);

export const findRow = (
	db: DbClient,
	namespace: string,
	key: string,
	scope: ResolvedScope,
): Promise<Row | null> =>
	db
		.select()
		.from(kvEntries)
		.where(sliceWhere(namespace, key, scope))
		.limit(1)
		.then((rows) => rows[0] ?? null);

export const isExpired = (row: Row, now: number): boolean =>
	row.expiresAt !== null && row.expiresAt <= now;

const toEntry = <T>(row: Row): KvEntry<T> => ({
	namespace: row.namespace,
	key: row.key,
	value: JSON.parse(row.value) as T,
	version: row.version,
	expiresAt: row.expiresAt,
	tenantId: row.tenantId,
	ownerId: row.ownerId,
});

// ---------- live layer ----------

export const KvLive = Layer.effect(
	Kv,
	Effect.gen(function* () {
		const db = yield* Db;
		/** Per-isolate namespace validators (see `registerSchema`). */
		const schemas = new Map<string, (value: unknown) => boolean>();

		const checkSchema = (
			namespace: string,
			value: unknown,
		): Effect.Effect<void, KvValidationError> => {
			const guard = schemas.get(namespace);
			return guard !== undefined && !guard(value)
				? Effect.fail(
						new KvValidationError({
							reason: `value rejected by schema registered for namespace "${namespace}"`,
						}),
					)
				: Effect.void;
		};

		return {
			get: (namespace, key, scope) =>
				Effect.gen(function* () {
					yield* validateKey(namespace, key);
					const resolved = yield* resolveScope(scope);
					yield* assertScope(resolved);
					const row = yield* Effect.promise(() => findRow(db, namespace, key, resolved));
					if (row === null) return null;
					if (isExpired(row, Date.now())) {
						yield* Effect.promise(() => db.delete(kvEntries).where(eq(kvEntries.id, row.id)));
						return null;
					}
					return toEntry(row);
				}),

			set: (namespace, key, value, options) =>
				Effect.gen(function* () {
					yield* validateKey(namespace, key);
					const serialized = yield* serialize(value);
					yield* checkSchema(namespace, value);
					const resolved = yield* resolveScope(options?.scope);
					yield* assertScope(resolved);
					const now = Date.now();
					const expiresAt =
						options?.ttlMs === undefined ? null : yield* validateTtl(options.ttlMs, now);

					if (options?.expectedVersion !== undefined) {
						const expected = options.expectedVersion;
						if (!Number.isInteger(expected) || expected < 1) {
							return yield* Effect.fail(
								new KvValidationError({ reason: "expectedVersion must be a positive integer" }),
							);
						}
						const [updated] = yield* Effect.promise(() =>
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
										sliceWhere(namespace, key, resolved),
										eq(kvEntries.version, expected),
										or(isNull(kvEntries.expiresAt), gt(kvEntries.expiresAt, now)),
									),
								)
								.returning(),
						);
						if (updated !== undefined) return toEntry(updated);
						const existing = yield* Effect.promise(() => findRow(db, namespace, key, resolved));
						if (existing !== null && isExpired(existing, now)) {
							yield* Effect.promise(() =>
								db.delete(kvEntries).where(eq(kvEntries.id, existing.id)),
							);
						}
						if (existing === null || isExpired(existing, now)) {
							return yield* Effect.fail(new KvNotFoundError({ namespace, key }));
						}
						return yield* Effect.fail(
							new KvConflictError({
								namespace,
								key,
								expectedVersion: expected,
								actualVersion: existing.version,
							}),
						);
					} else {
						const [row] = yield* Effect.promise(() =>
							db
								.insert(kvEntries)
								.values({
									namespace,
									key,
									tenantId: resolved.tenantId,
									ownerId: resolved.ownerId,
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
						return toEntry(row!);
					}
				}),

			setIfAbsent: (namespace, key, value, options) =>
				Effect.gen(function* () {
					yield* validateKey(namespace, key);
					const serialized = yield* serialize(value);
					yield* checkSchema(namespace, value);
					const resolved = yield* resolveScope(options?.scope);
					yield* assertScope(resolved);
					const now = Date.now();
					const expiresAt =
						options?.ttlMs === undefined ? null : yield* validateTtl(options.ttlMs, now);

					const insertOnce = () =>
						Effect.promise(() =>
							db
								.insert(kvEntries)
								.values({
									namespace,
									key,
									tenantId: resolved.tenantId,
									ownerId: resolved.ownerId,
									value: serialized,
									expiresAt,
									version: 1,
									createdAt: new Date(now),
									updatedAt: new Date(now),
								})
								.onConflictDoNothing()
								.returning({ id: kvEntries.id }),
						);

					const first = yield* insertOnce();
					if (first[0] !== undefined) return true;

					// Conflict: a live row already owns the slice → false. An
					// expired row is logically absent — claim it with a single
					// guarded delete (expired rows only) and retry the insert.
					const removed = yield* Effect.promise(() =>
						db
							.delete(kvEntries)
							.where(
								and(
									sliceWhere(namespace, key, resolved),
									isNotNull(kvEntries.expiresAt),
									lte(kvEntries.expiresAt, now),
								),
							)
							.returning({ id: kvEntries.id }),
					);
					if (removed[0] === undefined) return false;
					const retry = yield* insertOnce();
					return retry[0] !== undefined;
				}),

			delete: (namespace, key, scope) =>
				Effect.gen(function* () {
					yield* validateKey(namespace, key);
					const resolved = yield* resolveScope(scope);
					yield* assertScope(resolved);
					const now = Date.now();
					const rows = yield* Effect.promise(() =>
						db
							.delete(kvEntries)
							.where(sliceWhere(namespace, key, resolved))
							.returning({ expiresAt: kvEntries.expiresAt }),
					);
					const row = rows[0];
					if (row === undefined) return false;
					// Expired rows are removed too (lazy cleanup) but report false —
					// they were already logically absent.
					return row.expiresAt === null || row.expiresAt > now;
				}),

			increment: (namespace, key, by = 1, options) =>
				Effect.gen(function* () {
					yield* validateKey(namespace, key);
					if (typeof by !== "number" || !Number.isFinite(by)) {
						return yield* Effect.fail(
							new KvValidationError({ reason: "by must be a finite number" }),
						);
					}
					const resolved = yield* resolveScope(options?.scope);
					yield* assertScope(resolved);
					const now = Date.now();
					const hasTtl = options?.ttlMs !== undefined;
					const newExpiresAt = hasTtl ? yield* validateTtl(options.ttlMs!, now) : null;

					// One atomic upsert: missing → `by`; expired → reset to `by`
					// (fresh semantics, TTL re-applied); live numeric → value + by;
					// live non-numeric → value kept and reported via KvTypeError
					// below (version/updated_at stay untouched on that path).
					const expiredCond = sql`(${kvEntries.expiresAt} IS NOT NULL AND ${kvEntries.expiresAt} <= ${now})`;
					const numericCond = sql`json_type(${kvEntries.value}) IN ('integer','real')`;
					const [row] = yield* Effect.promise(() =>
						db
							.insert(kvEntries)
							.values({
								namespace,
								key,
								tenantId: resolved.tenantId,
								ownerId: resolved.ownerId,
								value: JSON.stringify(by),
								expiresAt: newExpiresAt,
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
									value: sql`CASE WHEN ${expiredCond} THEN ${by} WHEN ${numericCond} THEN json_extract(${kvEntries.value}, '$') + ${by} ELSE ${kvEntries.value} END`,
									// TTL is only rewritten on the expired-reset path or when
									// the live value is numeric (a successful increment) AND
									// ttlMs was given — a live non-numeric value keeps its
									// deadline even when ttlMs is passed (the KvTypeError
									// path below must not mutate the row at all).
									expiresAt: hasTtl
										? sql`CASE WHEN ${expiredCond} OR ${numericCond} THEN ${newExpiresAt} ELSE ${kvEntries.expiresAt} END`
										: sql`CASE WHEN ${expiredCond} THEN ${newExpiresAt} ELSE ${kvEntries.expiresAt} END`,
									version: sql`CASE WHEN ${expiredCond} THEN 1 WHEN ${numericCond} THEN ${kvEntries.version} + 1 ELSE ${kvEntries.version} END`,
									updatedAt: sql`CASE WHEN ${expiredCond} OR ${numericCond} THEN ${now} ELSE ${kvEntries.updatedAt} END`,
								},
							})
							.returning(),
					);
					const parsed: unknown = JSON.parse(row!.value);
					if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
						return yield* Effect.fail(
							new KvTypeError({
								namespace,
								key,
								reason: "existing value is not a number",
							}),
						);
					}
					return parsed;
				}),

			expire: (namespace, key, ttlMs, scope) =>
				Effect.gen(function* () {
					yield* validateKey(namespace, key);
					const resolved = yield* resolveScope(scope);
					yield* assertScope(resolved);
					const now = Date.now();
					const expiresAt = yield* validateTtl(ttlMs, now);
					const rows = yield* Effect.promise(() =>
						db
							.update(kvEntries)
							.set({ expiresAt, updatedAt: new Date(now) })
							.where(
								and(
									sliceWhere(namespace, key, resolved),
									or(isNull(kvEntries.expiresAt), gt(kvEntries.expiresAt, now)),
								),
							)
							.returning({ id: kvEntries.id }),
					);
					if (rows.length > 0) return true;
					// Align with get/delete: an already-expired row is logically
					// absent — remove it (lazy cleanup) and report false.
					yield* Effect.promise(() =>
						db
							.delete(kvEntries)
							.where(
								and(
									sliceWhere(namespace, key, resolved),
									isNotNull(kvEntries.expiresAt),
									lte(kvEntries.expiresAt, now),
								),
							),
					);
					return false;
				}),

			keys: (namespace, scope, options) =>
				Effect.gen(function* () {
					yield* validateNamespace(namespace);
					const resolved = yield* resolveScope(scope);
					yield* assertScope(resolved);
					const now = Date.now();
					if (
						options?.limit !== undefined &&
						(!Number.isInteger(options.limit) || options.limit < 1)
					) {
						return yield* Effect.fail(
							new KvValidationError({ reason: "limit must be a positive integer" }),
						);
					}
					const prefix = options?.prefix;
					// "" is a no-op filter (same as omitting prefix); anything
					// else must be a well-formed field.
					if (prefix !== undefined && prefix !== "") {
						const bad = validateField("prefix", prefix);
						if (bad !== null) return yield* Effect.fail(bad);
					}
					const limit = Math.min(options?.limit ?? DEFAULT_KEYS_LIMIT, MAX_KEYS_LIMIT);
					const conds: (SQL | undefined)[] = [
						eq(kvEntries.namespace, namespace),
						resolved.tenantId === null
							? isNull(kvEntries.tenantId)
							: eq(kvEntries.tenantId, resolved.tenantId),
						resolved.ownerId === null
							? isNull(kvEntries.ownerId)
							: eq(kvEntries.ownerId, resolved.ownerId),
						or(isNull(kvEntries.expiresAt), gt(kvEntries.expiresAt, now)),
					];
					if (prefix !== undefined && prefix !== "") {
						// instr-equality instead of LIKE — prefix needs no escaping.
						// instr is character-based, so astral (non-BMP) prefixes
						// work; JS string length would count UTF-16 code units.
						conds.push(sql`instr(${kvEntries.key}, ${prefix}) = 1`);
					}
					const rows = yield* Effect.promise(() =>
						db
							.select({ key: kvEntries.key })
							.from(kvEntries)
							.where(and(...conds))
							.orderBy(asc(kvEntries.key))
							.limit(limit),
					);
					return rows.map((r) => r.key);
				}),

			sweepExpired: () =>
				Effect.gen(function* () {
					const rows = yield* Effect.promise(() =>
						db
							.delete(kvEntries)
							.where(and(isNotNull(kvEntries.expiresAt), lte(kvEntries.expiresAt, Date.now())))
							.returning({ id: kvEntries.id }),
					);
					return rows.length;
				}),

			registerSchema: (namespace, validate) =>
				Effect.gen(function* () {
					yield* validateNamespace(namespace);
					schemas.set(namespace, validate);
				}),
		};
	}),
);
