import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { Forbidden, Principal, requireCanAs } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";

import { permissionEpoch, relationTuples } from "@ktb/db/schema";

export { permissionEpoch, rolePermissions, roles, subjectRoles } from "@ktb/db/schema";
export type { Role, RolePermission, SubjectRole } from "@ktb/db/schema";
export * from "./vocabulary.ts";

// ---------- vocabulary-facing types ----------

/** Grant effect stored in `role_permissions.effect`. */
export type PermissionEffect = "allow" | "deny";

/** Assignment subject kinds stored in `subject_roles.subject_kind`. */
export type SubjectKind = "user" | "group";

/**
 * Effective grant set returned by `Permissions.permissionsFor`: a map
 * from an internal grant key (`grantKey(resource, action)`) to the
 * winning effect. Deny always wins — the map never holds an "allow"
 * for a (resource, action) pair that also has a "deny" grant.
 */
export type GrantSet = ReadonlyMap<string, PermissionEffect>;

const GRANT_SEP = "\u001f";

/** Internal map key for a (resource, action) pair — NUL-separated so
 * resource/action strings containing dots cannot collide. */
export const grantKey = (resource: string, action: string): string =>
	`${resource}${GRANT_SEP}${action}`;

/** Earliest of two nullable expiry timestamps (NULL = never expires). */
const earliestExpiry = (a: Date | null, b: Date | null): Date | null => {
	if (a === null) return b;
	if (b === null) return a;
	return a.getTime() <= b.getTime() ? a : b;
};

// ---------- permission epoch ----------

const EPOCH_ROW_ID = 1;

/** Current permission epoch; 0 before the first bump/write. */
export async function readEpoch(db: DbClient): Promise<number> {
	const rows = await db
		.select({ epoch: permissionEpoch.epoch })
		.from(permissionEpoch)
		.where(eq(permissionEpoch.id, EPOCH_ROW_ID));
	return rows[0]?.epoch ?? 0;
}

/**
 * Bump the permission epoch — call after EVERY write to
 * `role_permissions`, `subject_roles`, `relation_tuples` (P-101), or
 * any group-membership table.
 * Cached grant sets key on the epoch, so the next resolve sees fresh
 * data without explicit cache purging.
 */
export async function bumpEpoch(db: DbClient): Promise<void> {
	await db
		.insert(permissionEpoch)
		.values({ id: EPOCH_ROW_ID, epoch: 1 })
		.onConflictDoUpdate({
			target: permissionEpoch.id,
			set: { epoch: sql`${permissionEpoch.epoch} + 1` },
		});
}

// ---------- ports ----------

/**
 * Group-membership port: which groups a user belongs to. Implemented
 * by the app/plugin that owns the membership table (plugins/rbac
 * adapts the groups plugin's `group_members` over raw SQL — this
 * package never imports a groups plugin). Absent implementation = no
 * group-derived grants.
 */
export class GroupMembership extends Context.Service<
	GroupMembership,
	{
		readonly groupIdsFor: (userId: string) => Effect.Effect<readonly string[]>;
	}
>()("@ktb/rbac/GroupMembership") {}

/**
 * Invalidation port: bump the epoch and drop cached grant sets.
 * Write paths that cannot reach `Permissions` directly (e.g. the
 * groups plugin's membership writes) consume this optionally — groups
 * declares `optionalDeps: ["rbac.services"]` so the edge orders the
 * rbac layer first when present.
 */
export class PermissionInvalidator extends Context.Service<
	PermissionInvalidator,
	{
		readonly invalidate: () => Effect.Effect<void>;
	}
>()("@ktb/rbac/PermissionInvalidator") {}

// ---------- resolution ----------

export interface PermissionOptions {
	/** Active tenant (P-053 `Tenant.id` is `string | number`; stored
	 * normalized to text). Undefined = global grants only —
	 * tenant-scoped grants never leak into a tenant-less context. */
	readonly tenantId?: string | number;
}

export interface PermissionsShape {
	/** Effective grant set for a user: direct user roles ∪ roles of
	 * every group the user belongs to, filtered to the tenant scope,
	 * unexpired only. */
	readonly permissionsFor: (userId: string, tenantId?: string | number) => Effect.Effect<GrantSet>;
	/** `permissionsFor(userId)` filtered to winning "allow" grants —
	 * deny entries never satisfy a check. */
	readonly canFor: (
		userId: string,
		resource: string,
		action: string,
		tenantId?: string | number,
	) => Effect.Effect<boolean>;
	/** `canFor` bound to the request `Principal` — false (fail closed)
	 * when no principal is bound. */
	readonly can: (
		resource: string,
		action: string,
		opts?: PermissionOptions,
	) => Effect.Effect<boolean>;
	/** `requirePermission` bound to a user id — fails `Forbidden`. */
	readonly requirePermissionFor: (
		userId: string,
		resource: string,
		action: string,
		tenantId?: string | number,
	) => Effect.Effect<void, Forbidden>;
	/** `can` + `Forbidden` on denial, bound to the `Principal`. */
	readonly requirePermission: (
		resource: string,
		action: string,
		opts?: PermissionOptions,
	) => Effect.Effect<void, Forbidden>;
	/** Object-level ReBAC check bound to the Principal: does the current
	 * principal hold `relation` on (objectType, objectId)? Matches tuples
	 * with object_id = objectId OR '*' (wildcard grants apply to every
	 * object of the type). Userset subjects expand: 'user' compares to
	 * principal.userId, 'group' via the GroupMembership port, 'role'
	 * recursively through member tuples (depth cap 4, visited-set cycle
	 * guard). Deny wins; tenant_id NULL-or-match and expires_at honored
	 * like grant resolution. Fails closed (false) with no Principal. */
	readonly canObject: (
		objectType: string,
		objectId: string,
		relation: string,
		opts?: PermissionOptions,
	) => Effect.Effect<boolean>;
	/** canObject + Forbidden(`rbac.<objectType>.<objectId>.<relation>`), bound to Principal. */
	readonly requireObject: (
		objectType: string,
		objectId: string,
		relation: string,
		opts?: PermissionOptions,
	) => Effect.Effect<void, Forbidden>;
	/** Bump the epoch and clear the local cache — call after any write
	 * to role_permissions / subject_roles / relation_tuples /
	 * membership tables. */
	readonly invalidate: () => Effect.Effect<void>;
}

/** Bound on the in-instance grant cache; cleared wholesale when hit. */
const CACHE_LIMIT = 1000;

interface CacheEntry {
	readonly epoch: number;
	readonly grants: GrantSet;
	/** Earliest grant expiry (ms) — re-resolve once it passes so
	 * `expires_at` is honoured even on cache hits. */
	readonly notAfter: number | null;
}

interface ObjectCacheEntry {
	readonly epoch: number;
	readonly result: boolean;
	/** Earliest tuple/member expiry (ms) seen during the check —
	 * re-resolve once it passes so `expires_at` is honoured on hits. */
	readonly notAfter: number | null;
}

const keyOf = (userId: string, tenantId: string | undefined): string =>
	`${userId}${GRANT_SEP}${tenantId ?? ""}`;

/**
 * Build the `Permissions` service over a DbClient. `groupIdsFor`
 * resolves a user's group ids through the `GroupMembership` port
 * (undefined = no group-derived grants). Exported for tests and for
 * composition roots that want a custom wiring.
 */
export const buildPermissions = (
	db: DbClient,
	groupIdsFor?: (userId: string) => Effect.Effect<readonly string[]>,
): PermissionsShape => {
	const cache = new Map<string, CacheEntry>();
	const objectCache = new Map<string, ObjectCacheEntry>();

	/** Max role→role member hops when expanding 'role' subjects in an
	 * object check (cycles are also cut by the visited set). */
	const MAX_ROLE_DEPTH = 4;

	const resolveObject = (
		userId: string,
		objectType: string,
		objectId: string,
		relation: string,
		tenantId: string | number | undefined,
	): Effect.Effect<boolean> =>
		Effect.gen(function* () {
			const tid = tenantId === undefined ? undefined : String(tenantId);
			const epoch = yield* Effect.promise(() => readEpoch(db));
			const key = `obj${GRANT_SEP}${objectType}${GRANT_SEP}${objectId}${GRANT_SEP}${relation}${GRANT_SEP}${userId}${GRANT_SEP}${tid ?? ""}`;
			const now = Date.now();
			const hit = objectCache.get(key);
			if (
				hit !== undefined &&
				hit.epoch === epoch &&
				(hit.notAfter === null || now < hit.notAfter)
			) {
				return hit.result;
			}

			const groupIds = groupIdsFor === undefined ? [] : yield* groupIdsFor(userId);
			// Same tenant/expiry scope as grant resolution: tenant_id NULL
			// is global, set = scoped; absent tenant context sees global
			// tuples only.
			// Stryker disable next-line ConditionalExpression: when tid is undefined the or-branch binds eq(tenantId, undefined) as NULL; `tenant_id = NULL` is never true, so `isNull OR (tenant_id = NULL)` is identical to `isNull` in a WHERE clause.
			const tenantCond =
				tid === undefined
					? isNull(relationTuples.tenantId)
					: or(isNull(relationTuples.tenantId), eq(relationTuples.tenantId, tid));
			const unexpired = or(
				isNull(relationTuples.expiresAt),
				gt(relationTuples.expiresAt, new Date(now)),
			);
			let notAfter: number | null = null;
			const noteExpiry = (expiresAt: Date | null) => {
				const exp = expiresAt === null ? null : expiresAt.getTime();
				// Stryker disable next-line EqualityOperator: exp === notAfter would assign the identical value — notAfter only ever stores the minimum expiry.
				if (exp !== null && (notAfter === null || exp < notAfter)) notAfter = exp;
			};

			// Does `subject` (a tuple subject: user / group / role)
			// reach the principal? 'role' subjects expand through member
			// tuples (object_type='role', object_id=<role name>,
			// relation='member'); nested roles recurse up to
			// MAX_ROLE_DEPTH hops with a visited set for cycles.
			// Member-tuple effect is ignored — membership is binary,
			// matching grant resolution.
			const subjectReaches = (
				subjectKind: string,
				subjectId: string,
				depth: number,
				visited: Set<string>,
			): Effect.Effect<boolean> =>
				Effect.gen(function* () {
					if (subjectKind === "user") return subjectId === userId;
					if (subjectKind === "group") return groupIds.includes(subjectId);
					if (subjectKind !== "role") return false;
					if (depth >= MAX_ROLE_DEPTH) return false;
					const visitKey = `role${GRANT_SEP}${subjectId}`;
					if (visited.has(visitKey)) return false;
					visited.add(visitKey);
					const memberRows = yield* Effect.promise(() =>
						db
							.select({
								subjectKind: relationTuples.subjectKind,
								subjectId: relationTuples.subjectId,
								expiresAt: relationTuples.expiresAt,
							})
							.from(relationTuples)
							.where(
								and(
									eq(relationTuples.objectType, "role"),
									eq(relationTuples.objectId, subjectId),
									eq(relationTuples.relation, "member"),
									tenantCond,
									unexpired,
								),
							),
					);
					for (const member of memberRows) {
						noteExpiry(member.expiresAt);
						if (yield* subjectReaches(member.subjectKind, member.subjectId, depth + 1, visited)) {
							return true;
						}
					}
					return false;
				});

			const tupleRows = yield* Effect.promise(() =>
				db
					.select({
						subjectKind: relationTuples.subjectKind,
						subjectId: relationTuples.subjectId,
						effect: relationTuples.effect,
						expiresAt: relationTuples.expiresAt,
					})
					.from(relationTuples)
					.where(
						and(
							eq(relationTuples.objectType, objectType),
							eq(relationTuples.relation, relation),
							or(eq(relationTuples.objectId, objectId), eq(relationTuples.objectId, "*")),
							tenantCond,
							unexpired,
						),
					),
			);

			let reachedAllow = false;
			let reachedDeny = false;
			const visited = new Set<string>();
			for (const row of tupleRows) {
				noteExpiry(row.expiresAt);
				if (!(yield* subjectReaches(row.subjectKind, row.subjectId, 0, visited))) continue;
				// Fail closed like grants: only the literal "allow"
				// grants; "deny" or corrupt effects deny.
				if (row.effect === "allow") reachedAllow = true;
				else reachedDeny = true;
			}
			const result = reachedAllow && !reachedDeny;
			// Stryker disable next-line ConditionalExpression,EqualityOperator,CallExpression: CACHE_LIMIT only bounds memory — every hit revalidates epoch and notAfter, so when or whether objectCache.clear() runs cannot change any result.
			if (objectCache.size >= CACHE_LIMIT) objectCache.clear();
			objectCache.set(key, { epoch, result, notAfter });
			return result;
		});

	const resolve = Effect.fnUntraced(function* (
		userId: string,
		tenantId: string | number | undefined,
	): Effect.fn.Return<GrantSet> {
		// Tenant ids are `string | number` (P-053); the column is TEXT,
		// so normalize once — "1" and 1 address the same grant.
		const tid = tenantId === undefined ? undefined : String(tenantId);
		const epoch = yield* Effect.promise(() => readEpoch(db));
		const key = keyOf(userId, tid);
		const hit = cache.get(key);
		const now = Date.now();
		if (hit !== undefined && hit.epoch === epoch && (hit.notAfter === null || now < hit.notAfter)) {
			return hit.grants;
		}

		const groupIds = groupIdsFor === undefined ? [] : yield* groupIdsFor(userId);
		// P-101: resolution reads the relation_tuples graph, not the
		// admin-facing role_permissions/subject_roles tables. Role
		// membership is a member tuple (object_type='role',
		// relation='member') whose subject is the user or one of their
		// groups; the member tuple's tenant/expiry scope the assignment
		// exactly like subject_roles did.
		// Stryker disable next-line ConditionalExpression,EqualityOperator: with empty groupIds, inArray([]) compiles to `false`, so the pushed (subjectKind='group' AND false) condition is always false and `or(userCond, false)` is identical to userCond alone.
		const subjectConds = [
			and(eq(relationTuples.subjectKind, "user"), eq(relationTuples.subjectId, userId)),
		];
		if (groupIds.length > 0) {
			subjectConds.push(
				and(eq(relationTuples.subjectKind, "group"), inArray(relationTuples.subjectId, groupIds)),
			);
		}
		// Stryker disable next-line ConditionalExpression: when tid is undefined the or-branch binds eq(tenantId, undefined) as NULL; `tenant_id = NULL` is never true, so `isNull OR (tenant_id = NULL)` is identical to `isNull` in a WHERE clause.
		const tenantCond =
			tid === undefined
				? isNull(relationTuples.tenantId)
				: or(isNull(relationTuples.tenantId), eq(relationTuples.tenantId, tid));
		const unexpired = or(
			isNull(relationTuples.expiresAt),
			gt(relationTuples.expiresAt, new Date(now)),
		);
		const memberRows = yield* Effect.promise(() =>
			db
				.select({
					roleName: relationTuples.objectId,
					expiresAt: relationTuples.expiresAt,
				})
				.from(relationTuples)
				.where(
					and(
						eq(relationTuples.objectType, "role"),
						eq(relationTuples.relation, "member"),
						or(...subjectConds),
						tenantCond,
						unexpired,
					),
				),
		);

		// Grant tuples carry the (resource, action, effect) triple:
		// object_id='*' wildcard, relation=action, subject_kind='role'
		// with the role NAME for role-derived grants — plus direct
		// 'user'/'group' subjects for forward-compatible direct grants.
		const membersByRole = new Map<string, typeof memberRows>();
		for (const member of memberRows) {
			const list = membersByRole.get(member.roleName);
			if (list === undefined) membersByRole.set(member.roleName, [member]);
			else list.push(member);
		}
		const grantSubjectConds = [...subjectConds];
		// Stryker disable next-line ConditionalExpression,EqualityOperator: with no member tuples, inArray([]) compiles to `false`, so the pushed (subjectKind='role' AND false) condition is always false and `or(...conds, false)` is identical to the subject conds alone.
		if (membersByRole.size > 0) {
			grantSubjectConds.push(
				and(
					eq(relationTuples.subjectKind, "role"),
					inArray(relationTuples.subjectId, [...membersByRole.keys()]),
				),
			);
		}
		const grantRows = yield* Effect.promise(() =>
			db
				.select({
					resource: relationTuples.objectType,
					action: relationTuples.relation,
					effect: relationTuples.effect,
					expiresAt: relationTuples.expiresAt,
					subjectKind: relationTuples.subjectKind,
					subjectId: relationTuples.subjectId,
				})
				.from(relationTuples)
				.where(
					and(eq(relationTuples.objectId, "*"), or(...grantSubjectConds), tenantCond, unexpired),
				),
		);

		// Merge role-derived and direct grants into rows shaped like the
		// old subject_roles ⋈ role_permissions join. A role grant's
		// effective expiry is the earliest of the member tuple's and the
		// grant tuple's expires_at (grant tuples carry NULL today; the
		// min is defensive). Deny wins across ALL sources in the loop
		// below regardless of which source produced the row.
		const rows: {
			resource: string;
			action: string;
			effect: string;
			expiresAt: Date | null;
		}[] = [];
		for (const row of grantRows) {
			if (row.subjectKind === "role") {
				// v8 ignore next -- grant role subjects are drawn from membersByRole keys, so get() never misses
				for (const member of membersByRole.get(row.subjectId) ?? []) {
					rows.push({
						resource: row.resource,
						action: row.action,
						effect: row.effect,
						expiresAt: earliestExpiry(member.expiresAt, row.expiresAt),
					});
				}
			} else {
				rows.push({
					resource: row.resource,
					action: row.action,
					effect: row.effect,
					expiresAt: row.expiresAt,
				});
			}
		}

		const grants = new Map<string, PermissionEffect>();
		let notAfter: number | null = null;
		for (const row of rows) {
			// Fail closed: only the literal "allow" grants; anything else
			// ("deny" or corrupt data) denies.
			const effect: PermissionEffect = row.effect === "allow" ? "allow" : "deny";
			const key = grantKey(row.resource, row.action);
			// Deny always wins over allow regardless of row order.
			if (effect === "deny" || !grants.has(key)) {
				grants.set(key, effect);
			}
			const exp = row.expiresAt === null ? null : row.expiresAt.getTime();
			// Stryker disable next-line EqualityOperator: exp === notAfter would assign the identical value — notAfter only ever stores the minimum expiry, so `<` and `<=` are indistinguishable.
			if (exp !== null && (notAfter === null || exp < notAfter)) notAfter = exp;
		}
		// Stryker disable next-line ConditionalExpression,EqualityOperator,CallExpression: CACHE_LIMIT only bounds memory — every cache hit revalidates epoch and notAfter, so when or whether cache.clear() runs cannot change any resolve result.
		if (cache.size >= CACHE_LIMIT) cache.clear();
		cache.set(key, { epoch, grants, notAfter });
		return grants;
	});

	const permissionsFor: PermissionsShape["permissionsFor"] = (userId, tenantId) =>
		resolve(userId, tenantId);

	const canFor: PermissionsShape["canFor"] = (userId, resource, action, tenantId) =>
		Effect.map(
			resolve(userId, tenantId),
			(grants) => grants.get(grantKey(resource, action)) === "allow",
		);

	const can: PermissionsShape["can"] = (resource, action, opts) =>
		Effect.flatMap(Principal, (principal) =>
			principal === null
				? Effect.succeed(false)
				: canFor(principal.userId, resource, action, opts?.tenantId),
		);

	const requirePermissionFor: PermissionsShape["requirePermissionFor"] = (
		userId,
		resource,
		action,
		tenantId,
	) =>
		Effect.flatMap(canFor(userId, resource, action, tenantId), (ok) =>
			ok ? Effect.void : Effect.fail(new Forbidden({ path: `rbac.${resource}.${action}` })),
		);

	const requirePermission: PermissionsShape["requirePermission"] = (resource, action, opts) =>
		Effect.flatMap(Principal, (principal) =>
			principal === null
				? Effect.fail(new Forbidden({ path: `rbac.${resource}.${action}` }))
				: requirePermissionFor(principal.userId, resource, action, opts?.tenantId),
		);

	const canObject: PermissionsShape["canObject"] = (objectType, objectId, relation, opts) =>
		Effect.flatMap(Principal, (principal) =>
			principal === null
				? Effect.succeed(false)
				: resolveObject(principal.userId, objectType, objectId, relation, opts?.tenantId),
		);

	const requireObject: PermissionsShape["requireObject"] = (
		objectType,
		objectId,
		relation,
		opts,
	) => {
		const path = `rbac.${objectType}.${objectId}.${relation}`;
		return Effect.flatMap(Principal, (principal) =>
			principal === null
				? Effect.fail(new Forbidden({ path }))
				: Effect.flatMap(
						resolveObject(principal.userId, objectType, objectId, relation, opts?.tenantId),
						(ok) => (ok ? Effect.void : Effect.fail(new Forbidden({ path }))),
					),
		);
	};

	const invalidate: PermissionsShape["invalidate"] = () =>
		// Stryker disable next-line ArrowFunction: bumpEpoch already invalidates every cached entry through the epoch check on read — cache.clear() is redundant.
		Effect.promise(() => bumpEpoch(db)).pipe(Effect.tap(() => Effect.sync(() => cache.clear())));

	return {
		permissionsFor,
		canFor,
		can,
		requirePermissionFor,
		requirePermission,
		canObject,
		requireObject,
		invalidate,
	};
};

export class Permissions extends Context.Service<Permissions, PermissionsShape>()(
	"@ktb/rbac/Permissions",
) {}

/**
 * Effect that builds the `Permissions` shape from the environment:
 * `Db` plus the optional `GroupMembership` port. Shared by
 * `PermissionsLive` and by plugins that need the same instance for a
 * second service tag (e.g. `PermissionInvalidator`).
 */
export const permissionsService = Effect.gen(function* () {
	const db = yield* Db;
	const membership = yield* Effect.serviceOption(GroupMembership);
	return buildPermissions(db, Option.isSome(membership) ? membership.value.groupIdsFor : undefined);
});

export const PermissionsLive = Layer.effect(Permissions, permissionsService);

// ---------- relation tuple writes ----------

/** Tenant predicate for tuple natural-key matching: NULL tenantId
 * matches only NULL rows (SQL `=` never matches NULL, so global
 * tuples are checked separately). */
const tupleTenant = (tenantId: string | null) =>
	tenantId === null
		? sql`${relationTuples.tenantId} is null`
		: eq(relationTuples.tenantId, tenantId);

/** Tuple fields accepted by `writeRelationTuple` — every optional
 * field defaults to the "global, never expires, system-granted"
 * shape (`effect` "allow", `tenantId`/`expiresAt`/`grantedBy` null). */
export interface RelationTupleWrite {
	readonly objectType: string;
	readonly objectId: string;
	readonly relation: string;
	readonly subjectKind: "user" | "group" | "role";
	readonly subjectId: string;
	readonly effect?: "allow" | "deny";
	readonly tenantId?: string | null;
	readonly expiresAt?: Date | null;
	readonly grantedBy?: string | null;
}

/**
 * Upsert a `relation_tuples` row by its natural key
 * (object_type, object_id, relation, subject_kind, subject_id,
 * tenant_id — NULL-safe). On a hit the mutable fields
 * (effect/expires_at/granted_by/tenant_id) are updated in place; on a
 * miss the row is inserted. Bumps the permission epoch so every
 * cached grant/object resolution re-reads. Uniqueness is enforced
 * here, not by the schema (SQLite treats NULLs as distinct).
 */
export const writeRelationTuple = async (
	db: DbClient,
	tuple: RelationTupleWrite,
): Promise<void> => {
	const tenantId = tuple.tenantId ?? null;
	const effect = tuple.effect ?? "allow";
	const expiresAt = tuple.expiresAt ?? null;
	const grantedBy = tuple.grantedBy ?? null;
	const rows = await db
		.select({ id: relationTuples.id })
		.from(relationTuples)
		.where(
			and(
				eq(relationTuples.objectType, tuple.objectType),
				eq(relationTuples.objectId, tuple.objectId),
				eq(relationTuples.relation, tuple.relation),
				eq(relationTuples.subjectKind, tuple.subjectKind),
				eq(relationTuples.subjectId, tuple.subjectId),
				tupleTenant(tenantId),
			),
		);
	const existing = rows[0];
	if (existing !== undefined) {
		await db
			.update(relationTuples)
			.set({ effect, expiresAt, grantedBy, tenantId })
			.where(eq(relationTuples.id, existing.id));
	} else {
		await db.insert(relationTuples).values({
			objectType: tuple.objectType,
			objectId: tuple.objectId,
			relation: tuple.relation,
			subjectKind: tuple.subjectKind,
			subjectId: tuple.subjectId,
			effect,
			tenantId,
			expiresAt,
			grantedBy,
			createdAt: new Date(),
		});
	}
	await bumpEpoch(db);
};

/**
 * Delete `relation_tuples` rows matching the given fields — every
 * field is optional except `objectType`; `objectId` omitted matches
 * every object id of the type. `tenantId` semantics: `undefined`
 * matches any tenant (the field is skipped), `null` matches only
 * global (tenant_id IS NULL) rows, a string matches that tenant.
 * Returns the number of deleted rows and bumps the permission epoch
 * only when at least one row was removed.
 */
export const deleteRelationTuples = async (
	db: DbClient,
	match: {
		readonly objectType: string;
		readonly objectId?: string;
		readonly relation?: string;
		readonly subjectKind?: string;
		readonly subjectId?: string;
		readonly tenantId?: string | null;
	},
): Promise<number> => {
	const conds = [eq(relationTuples.objectType, match.objectType)];
	if (match.objectId !== undefined) conds.push(eq(relationTuples.objectId, match.objectId));
	if (match.relation !== undefined) conds.push(eq(relationTuples.relation, match.relation));
	if (match.subjectKind !== undefined)
		conds.push(eq(relationTuples.subjectKind, match.subjectKind));
	if (match.subjectId !== undefined) conds.push(eq(relationTuples.subjectId, match.subjectId));
	if (match.tenantId !== undefined) {
		conds.push(
			match.tenantId === null
				? sql`${relationTuples.tenantId} is null`
				: eq(relationTuples.tenantId, match.tenantId),
		);
	}
	const rows = await db
		.delete(relationTuples)
		.where(and(...conds))
		.returning({ id: relationTuples.id });
	if (rows.length > 0) await bumpEpoch(db);
	return rows.length;
};

// ---------- entity authz seam ----------

/** Per-entity authz mode (P-054): `static` keeps today's permix
 * `rulesFor` behaviour; `rbac` lets dynamic role grants decide
 * (allow grants minus deny grants). Default is `static` — adoption is
 * per-entity and explicit. */
export type EntityAuthzMode = "static" | "rbac";

/** Descriptor an entity exposes to its guards. `resource`/`action`
 * name the permix path in static mode (`patient.read`) and the flat
 * grant in rbac mode — same vocabulary, one spelling. Discriminated
 * on `mode` so `requireEntityAccess` only demands `Permissions` in
 * the environment for rbac-mode entities. */
export interface StaticEntityAuthz {
	readonly mode: "static";
	readonly resource: string;
	readonly action: string;
}

export interface RbacEntityAuthz {
	readonly mode: "rbac";
	readonly resource: string;
	readonly action: string;
	readonly tenantId?: string | number;
}

export type EntityAuthz = StaticEntityAuthz | RbacEntityAuthz;

export const entityAuthz = <M extends EntityAuthzMode>(
	mode: M,
	resource: string,
	action: string,
	opts?: { readonly tenantId?: string | number },
): Extract<EntityAuthz, { readonly mode: M }> =>
	({ mode, resource, action, tenantId: opts?.tenantId }) as Extract<
		EntityAuthz,
		{ readonly mode: M }
	>;

/**
 * Guard consumed by entity services: `static` delegates to the permix
 * `requireCanAs` path (unchanged behaviour, entity arg forwarded);
 * `rbac` resolves dynamic grants through `Permissions` (deny wins,
 * tenant-filtered, `expires_at` honoured). Requires `Permissions` in
 * the environment only in rbac mode — static callers never pull the
 * rbac layer in.
 */
export function requireEntityAccess(
	authz: StaticEntityAuthz,
	entity?: unknown,
): Effect.Effect<void, Forbidden, never>;
export function requireEntityAccess(
	authz: RbacEntityAuthz,
	entity?: unknown,
): Effect.Effect<void, Forbidden, Permissions>;
export function requireEntityAccess(
	authz: EntityAuthz,
	entity?: unknown,
): Effect.Effect<void, Forbidden, Permissions> {
	return authz.mode === "rbac"
		? Effect.flatMap(Permissions, (permissions) =>
				permissions.requirePermission(authz.resource, authz.action, {
					tenantId: authz.tenantId,
				}),
			)
		: requireCanAs(`${authz.resource}.${authz.action}` as never, entity as never);
}
