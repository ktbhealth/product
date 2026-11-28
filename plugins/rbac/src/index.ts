import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { ShieldCheckIcon } from "lucide-react";

import { Forbidden, Principal } from "@ktb/authz";
import { audit, auditServicesPlugin } from "@ktb/audit";
import { Db, type DbClient } from "@ktb/db";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { PlatformAdmin, platformAdminPlugin, platformPanelPlugin } from "@ktb/platform";
import {
	bumpEpoch,
	GroupMembership,
	PermissionInvalidator,
	permissionsService,
	Permissions,
	splitPermission,
	roles,
	permissionEpoch,
	type PermissionEffect,
	type Role,
	type SubjectKind,
} from "@ktb/rbac";
import { Command, Query } from "@effect-server-utils/cqrs";

import { relationTuples, type RelationTuple } from "@ktb/db/schema";
import { PERMISSION_CATALOG } from "./catalog.ts";
import { RbacCommands, RbacQueries } from "./api.ts";
import { RbacPlatformPage } from "./platform-page.tsx";
import { ensureSuperadminRole, SUPERADMIN_ROLE_NAME } from "./seed.ts";

// ---------- row shapes ----------

export type { Role };

/** Grant row shape kept for the admin wire (`RolePermissionRow` in
 * api.ts): tuples carry no `role_id`, so the row is projected back —
 * `id` is the tuple id, `resource`/`action` the tuple's
 * object_type/relation. */
export interface RolePermission {
	readonly id: number;
	readonly roleId: number;
	readonly resource: string;
	readonly action: string;
	readonly effect: PermissionEffect;
	readonly createdAt: Date;
}

/** Assignment row shape (`SubjectRoleRow` in api.ts): a member tuple
 * projected back — `id` is the tuple id (`unassignSubject` deletes by
 * it), `roleId` resolves through the `roles` table by name (0 when the
 * role exists only as tuples). */
export interface SubjectRole {
	readonly id: number;
	readonly subjectKind: SubjectKind;
	readonly subjectId: string;
	readonly roleId: number;
	readonly tenantId: string | null;
	readonly grantedBy: string | null;
	readonly expiresAt: Date | null;
	readonly createdAt: Date;
}

export interface AssignmentRow extends SubjectRole {
	readonly roleName: string;
}

/** Wire shapes mirroring api.ts schemas — what the panel page
 * receives as loader `data` (dates survive JSON as ISO strings on
 * the client; the view only formats them). */
export interface RoleWire {
	readonly id: number;
	readonly name: string;
	readonly description: string | null;
	readonly meta: string | null;
	readonly createdAt: Date;
}

export interface RolePermissionWire {
	readonly id: number;
	readonly roleId: number;
	readonly resource: string;
	readonly action: string;
	readonly effect: PermissionEffect;
}

export interface RoleDetailWire {
	readonly role: RoleWire;
	readonly permissions: readonly RolePermissionWire[];
}

export interface AdminRbacPageData {
	readonly roles: readonly RoleWire[];
	readonly details: readonly RoleDetailWire[];
	readonly assignments: readonly AssignmentRow[];
	readonly catalog: readonly { key: string; resource: string; action: string }[];
}

// ---------- repo functions (async, DbClient — same contract as
// plugins/groups: callers MUST have passed the PlatformAdmin gate) ----------

const toRoleRow = (r: Role) => ({
	id: r.id,
	name: r.name,
	description: r.description,
	meta: r.meta,
	createdAt: r.createdAt,
});

/** Role names that exist only as tuples — direct `relation_tuples`
 * writes (scripts, other plugins) can create grant/member tuples
 * naming a role with no `roles` row. Grant tuples count only in the
 * admin shape (`object_id = '*'`); entity-level role subjects
 * (`object_id = <entity>`) are not role definitions. */
async function tupleOnlyRoleNames(db: DbClient, known: ReadonlySet<string>): Promise<string[]> {
	const grants = await db
		.select({ subjectId: relationTuples.subjectId })
		.from(relationTuples)
		.where(and(eq(relationTuples.subjectKind, "role"), eq(relationTuples.objectId, "*")));
	const members = await db
		.select({ objectId: relationTuples.objectId })
		.from(relationTuples)
		.where(and(eq(relationTuples.objectType, "role"), eq(relationTuples.relation, "member")));
	const names = new Set<string>();
	for (const g of grants) names.add(g.subjectId);
	for (const m of members) names.add(m.objectId);
	return [...names].filter((n) => !known.has(n)).sort();
}

export async function listRoles(db: DbClient): Promise<Role[]> {
	const rows = await db.select().from(roles).orderBy(roles.name);
	// Union in tuple-only roles: they have no metadata, so they get a
	// synthetic negative id (real ids are positive autoincrement) —
	// sorted names keep the mapping deterministic across calls, and
	// commands on them fail closed (getRole → null).
	const missing = await tupleOnlyRoleNames(db, new Set(rows.map((r) => r.name)));
	return [
		...rows,
		...missing.map((name, i) => ({
			id: -(i + 1),
			name,
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		})),
	];
}

export async function getRole(db: DbClient, id: number): Promise<Role | null> {
	const rows = await db.select().from(roles).where(eq(roles.id, id));
	return rows[0] ?? null;
}

export async function listRolePermissions(db: DbClient, roleId: number): Promise<RolePermission[]> {
	const role = await getRole(db, roleId);
	if (role === null) return [];
	// Grant tuples for the role: (<resource>,'*',<action>,'role',<name>),
	// global scope only — tenant-scoped grant tuples are not part of
	// the admin grant set (the write path never creates them).
	const rows = await db
		.select()
		.from(relationTuples)
		.where(
			and(
				eq(relationTuples.subjectKind, "role"),
				eq(relationTuples.subjectId, role.name),
				eq(relationTuples.objectId, "*"),
				sql`${relationTuples.tenantId} is null`,
			),
		)
		.orderBy(relationTuples.id);
	return rows.map((t) => ({
		id: t.id,
		roleId,
		resource: t.objectType,
		action: t.relation,
		effect: t.effect as PermissionEffect,
		createdAt: t.createdAt,
	}));
}

export async function listAssignments(db: DbClient): Promise<AssignmentRow[]> {
	// Member tuples ARE the assignments; the roles table only supplies
	// roleId (0 for tuple-only roles — roleName carries the identity).
	const rows = await db
		.select({ tuple: relationTuples, roleId: roles.id })
		.from(relationTuples)
		.leftJoin(roles, eq(roles.name, relationTuples.objectId))
		.where(and(eq(relationTuples.objectType, "role"), eq(relationTuples.relation, "member")))
		.orderBy(desc(relationTuples.id));
	return rows.map(({ tuple: t, roleId }) => ({
		id: t.id,
		subjectKind: t.subjectKind as SubjectKind,
		subjectId: t.subjectId,
		roleId: roleId ?? 0,
		roleName: t.objectId,
		tenantId: t.tenantId,
		grantedBy: t.grantedBy,
		expiresAt: t.expiresAt,
		createdAt: t.createdAt,
	}));
}

export async function createRole(
	db: DbClient,
	input: { name: string; description?: string | null; meta?: string | null },
): Promise<Role | null> {
	const rows = await db
		.insert(roles)
		.values({
			name: input.name,
			description: input.description ?? null,
			meta: input.meta ?? null,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.returning();
	return rows[0] ?? null;
}

export async function updateRole(
	db: DbClient,
	input: { id: number; name?: string; description?: string | null; meta?: string | null },
): Promise<Role | null> {
	const patch: Partial<typeof roles.$inferInsert> = {};
	if (input.name !== undefined) patch.name = input.name;
	if (input.description !== undefined) patch.description = input.description;
	if (input.meta !== undefined) patch.meta = input.meta;
	if (Object.keys(patch).length === 0) return getRole(db, input.id);
	// P-101: tuples key on the role NAME — a rename must rewrite both
	// tuple shapes (grant tuples carry it in subject_id, member tuples
	// in object_id), so the previous name is needed up front.
	let previousName: string | null = null;
	if (input.name !== undefined) {
		const existing = await getRole(db, input.id);
		if (existing === null) return null;
		previousName = existing.name;
	}
	const rows = await db.update(roles).set(patch).where(eq(roles.id, input.id)).returning();
	const row = rows[0] ?? null;
	if (
		row !== null &&
		previousName !== null &&
		input.name !== undefined &&
		input.name !== previousName
	) {
		const newName = input.name;
		await db
			.update(relationTuples)
			.set({ subjectId: newName })
			.where(
				and(eq(relationTuples.subjectKind, "role"), eq(relationTuples.subjectId, previousName)),
			);
		await db
			.update(relationTuples)
			.set({ objectId: newName })
			.where(
				and(
					eq(relationTuples.objectType, "role"),
					eq(relationTuples.objectId, previousName),
					eq(relationTuples.relation, "member"),
				),
			);
	}
	return row;
}

export async function deleteRole(db: DbClient, id: number): Promise<void> {
	// P-101: resolve the name first — tuples carry it polymorphically
	// (grant tuples in subject_id, member tuples in object_id).
	const role = await getRole(db, id);
	await db.delete(roles).where(eq(roles.id, id));
	if (role === null) return;
	await db
		.delete(relationTuples)
		.where(
			or(
				and(eq(relationTuples.subjectKind, "role"), eq(relationTuples.subjectId, role.name)),
				and(eq(relationTuples.objectType, "role"), eq(relationTuples.objectId, role.name)),
			),
		);
}

/**
 * T-188 grant mirrors: strict `tenantPolicy` resolution hides
 * `tenant_id NULL` tuples, so a role's global grant catalog must
 * exist pinned to every tenant the role has member tuples in. Mirrors
 * are DERIVED state — `pinRoleGrantMirrors` inserts the missing
 * (natural-key) copies after membership writes, and the grant write
 * paths (`setRolePermission` / `revokeRolePermission`) delete-then-
 * repin the affected grant so a revoked or re-effected grant can
 * never linger pinned. Migration 0064 backfills the same rule for
 * pre-existing data; mirrors are never edited directly through the
 * admin surface. `grant` narrows the sync to one (resource, action)
 * pair — omit it to mirror the role's whole catalog.
 */
const pinRoleGrantMirrors = (
	db: DbClient,
	roleName: string,
	grant?: { readonly resource: string; readonly action: string },
) =>
	db.run(sql`
		INSERT INTO relation_tuples (object_type, object_id, relation, subject_kind, subject_id, effect, tenant_id, expires_at, granted_by, created_at)
		SELECT g.object_type, g.object_id, g.relation, g.subject_kind, g.subject_id, g.effect, m.tenant_id, g.expires_at, g.granted_by, g.created_at
		FROM relation_tuples g
		JOIN (
			SELECT DISTINCT object_id AS role_name, tenant_id
			FROM relation_tuples
			WHERE object_type = 'role' AND relation = 'member' AND tenant_id IS NOT NULL
		) m ON m.role_name = g.subject_id
		WHERE g.object_id = '*' AND g.subject_kind = 'role' AND g.subject_id = ${roleName}
			AND g.tenant_id IS NULL
			${grant === undefined ? sql`` : sql`AND g.object_type = ${grant.resource} AND g.relation = ${grant.action}`}
		AND NOT EXISTS (
			SELECT 1 FROM relation_tuples x
			WHERE x.object_type = g.object_type AND x.object_id = g.object_id
				AND x.relation = g.relation AND x.subject_kind = g.subject_kind
				AND x.subject_id = g.subject_id AND x.tenant_id = m.tenant_id
		)`);

/** Drop the tenant-pinned mirrors of one (resource, action) grant of
 * `roleName` — callers either re-derive via {@link pinRoleGrantMirrors}
 * or leave them gone after a revoke. */
const deleteGrantMirrors = (
	db: DbClient,
	roleName: string,
	grant: { readonly resource: string; readonly action: string },
) =>
	db
		.delete(relationTuples)
		.where(
			and(
				eq(relationTuples.objectType, grant.resource),
				eq(relationTuples.objectId, "*"),
				eq(relationTuples.relation, grant.action),
				eq(relationTuples.subjectKind, "role"),
				eq(relationTuples.subjectId, roleName),
				sql`${relationTuples.tenantId} is not null`,
			),
		);

export async function setRolePermission(
	db: DbClient,
	input: { roleId: number; resource: string; action: string; effect: PermissionEffect },
): Promise<void> {
	// Grant tuples key on the role NAME — resolve it once. A missing
	// role writes nothing (the command layer rejects it upstream).
	const role = await getRole(db, input.roleId);
	if (role === null) return;
	await upsertRelationTuple(db, {
		objectType: input.resource,
		objectId: "*",
		relation: input.action,
		subjectKind: "role",
		subjectId: role.name,
		effect: input.effect,
		tenantId: null,
		expiresAt: null,
		grantedBy: null,
	});
	// Re-pin this grant's tenant mirrors: effect/expires changes must
	// propagate and member tenants missing the mirror get it (T-188).
	await deleteGrantMirrors(db, role.name, input);
	await pinRoleGrantMirrors(db, role.name, input);
}

export async function revokeRolePermission(
	db: DbClient,
	input: { roleId: number; resource: string; action: string },
): Promise<void> {
	// Drop the grant tuple (role name lookup needed — tuples key on
	// name, not id) plus its tenant-pinned mirrors — a revoked grant
	// must not linger under strict tenantPolicy (T-188).
	const role = await getRole(db, input.roleId);
	if (role === null) return;
	await db
		.delete(relationTuples)
		.where(
			and(
				eq(relationTuples.objectType, input.resource),
				eq(relationTuples.objectId, "*"),
				eq(relationTuples.relation, input.action),
				eq(relationTuples.subjectKind, "role"),
				eq(relationTuples.subjectId, role.name),
				sql`${relationTuples.tenantId} is null`,
			),
		);
	await deleteGrantMirrors(db, role.name, input);
}

const normalizeExpiresAt = (input: Date | string | number | null | undefined): Date | null => {
	if (input === null || input === undefined) return null;
	const d = input instanceof Date ? input : new Date(input);
	return Number.isNaN(d.getTime()) ? null : d;
};

/** Find the member tuple for the same (role, subject, tenant)
 * triple — tenant NULL matches only NULL (SQL `=` never matches NULL,
 * so global grants are checked separately). */
async function findMemberTuple(
	db: DbClient,
	input: {
		roleName: string;
		subjectKind: SubjectKind;
		subjectId: string;
		tenantId: string | null;
	},
): Promise<RelationTuple | null> {
	const rows = await db
		.select()
		.from(relationTuples)
		.where(
			and(
				eq(relationTuples.objectType, "role"),
				eq(relationTuples.objectId, input.roleName),
				eq(relationTuples.relation, "member"),
				eq(relationTuples.subjectKind, input.subjectKind),
				eq(relationTuples.subjectId, input.subjectId),
				tupleTenant(input.tenantId),
			),
		);
	return rows[0] ?? null;
}

// ---------- relation tuples (the only grant store, P-101) ----------

/** Tenant predicate shared by tuple reads/writes: NULL tenantId
 * matches only NULL rows (SQL `=` never matches NULL, so global
 * tuples are checked separately). */
const tupleTenant = (tenantId: string | null) =>
	tenantId === null
		? sql`${relationTuples.tenantId} is null`
		: eq(relationTuples.tenantId, tenantId);

/**
 * Upsert a grant/member tuple by its natural key
 * (object_type, object_id, relation, subject_kind, subject_id,
 * tenant_id — NULL-safe). Natural-key uniqueness is enforced by this
 * find-then-write (tenant_id NULLs are distinct in SQLite — same
 * caveat the dropped `subject_roles` table had).
 */
async function upsertRelationTuple(
	db: DbClient,
	tuple: {
		objectType: string;
		objectId: string;
		relation: string;
		subjectKind: string;
		subjectId: string;
		effect: PermissionEffect;
		tenantId: string | null;
		expiresAt: Date | null;
		grantedBy: string | null;
	},
): Promise<void> {
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
				tupleTenant(tuple.tenantId),
			),
		);
	const existing = rows[0];
	if (existing !== undefined) {
		await db
			.update(relationTuples)
			.set({ effect: tuple.effect, expiresAt: tuple.expiresAt, grantedBy: tuple.grantedBy })
			.where(eq(relationTuples.id, existing.id));
	} else {
		await db.insert(relationTuples).values({ ...tuple, createdAt: new Date() });
	}
}

export async function assignSubject(
	db: DbClient,
	input: {
		subjectKind: SubjectKind;
		subjectId: string;
		roleId: number;
		tenantId?: string | number | null;
		expiresAt?: Date | string | number | null;
		grantedBy?: string | null;
	},
): Promise<AssignmentRow | null> {
	// Member tuples key on the role NAME — resolve it once; a missing
	// role assigns nothing (the command layer rejects it upstream).
	const role = await getRole(db, input.roleId);
	if (role === null) return null;
	const expiresAt = normalizeExpiresAt(input.expiresAt);
	// TEXT column; P-053 tenant ids are string|number — normalize.
	const tenantId = input.tenantId == null ? null : String(input.tenantId);
	const existing = await findMemberTuple(db, {
		roleName: role.name,
		subjectKind: input.subjectKind,
		subjectId: input.subjectId,
		tenantId,
	});
	let tuple: RelationTuple | undefined;
	if (existing !== null) {
		// Re-assigning the same triple refreshes expiry/granter in place.
		const rows = await db
			.update(relationTuples)
			.set({ expiresAt, grantedBy: input.grantedBy ?? existing.grantedBy })
			.where(eq(relationTuples.id, existing.id))
			.returning();
		tuple = rows[0];
	} else {
		const rows = await db
			.insert(relationTuples)
			.values({
				objectType: "role",
				objectId: role.name,
				relation: "member",
				subjectKind: input.subjectKind,
				subjectId: input.subjectId,
				effect: "allow",
				tenantId,
				expiresAt,
				grantedBy: input.grantedBy ?? null,
				createdAt: new Date(),
			})
			.returning();
		tuple = rows[0];
	}
	if (tuple === undefined) return null;
	// T-188: a tenant-pinned membership needs the role's grant catalog
	// mirrored to that tenant — strict tenantPolicy hides the global
	// (tenant_id NULL) grant tuples. Global (NULL tenant) assignments
	// create no tenant scope, so they pin nothing.
	if (tenantId !== null) await pinRoleGrantMirrors(db, role.name);
	return {
		id: tuple.id,
		subjectKind: input.subjectKind,
		subjectId: input.subjectId,
		roleId: role.id,
		roleName: role.name,
		tenantId: tuple.tenantId,
		grantedBy: tuple.grantedBy,
		expiresAt: tuple.expiresAt,
		createdAt: tuple.createdAt,
	};
}

export async function unassignSubject(db: DbClient, id: number): Promise<void> {
	// `id` is the member tuple's id — drop it directly. The audit path
	// reads the row beforehand via getSubjectRole.
	await db
		.delete(relationTuples)
		.where(
			and(
				eq(relationTuples.id, id),
				eq(relationTuples.objectType, "role"),
				eq(relationTuples.relation, "member"),
			),
		);
}

/** Single assignment lookup by member-tuple id — the audit path reads
 * the row before `unassignSubject` deletes it. */
export async function getSubjectRole(db: DbClient, id: number): Promise<SubjectRole | null> {
	const rows = await db
		.select()
		.from(relationTuples)
		.where(
			and(
				eq(relationTuples.id, id),
				eq(relationTuples.objectType, "role"),
				eq(relationTuples.relation, "member"),
			),
		);
	const t = rows[0];
	if (t === undefined) return null;
	const roleRows = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, t.objectId));
	return {
		id: t.id,
		subjectKind: t.subjectKind as SubjectKind,
		subjectId: t.subjectId,
		roleId: roleRows[0]?.id ?? 0,
		tenantId: t.tenantId,
		grantedBy: t.grantedBy,
		expiresAt: t.expiresAt,
		createdAt: t.createdAt,
	};
}

/**
 * Group ids a user belongs to, read straight off the groups plugin's
 * `group_members` table over raw SQL — plugins never import each
 * other, so the membership shape is duplicated here as a read-only
 * contract (member_kind='user', member_id=userId → group_id).
 */
export async function groupIdsForUser(db: DbClient, userId: string): Promise<string[]> {
	const rows = await db.all<{ group_id: number }>(
		sql`select group_id from group_members where member_kind = 'user' and member_id = ${userId}`,
	);
	return rows.map((r) => String(r.group_id));
}

// ---------- services ----------

const GroupMembershipLive = Layer.effect(
	GroupMembership,
	Effect.gen(function* () {
		const db = yield* Db;
		return GroupMembership.of({
			groupIdsFor: (userId) => Effect.promise(() => groupIdsForUser(db, userId)),
		});
	}),
);

/** `Permissions` + `PermissionInvalidator` sharing one instance — the
 * invalidator is what write paths in OTHER plugins (groups membership)
 * call to bump the epoch. `GroupMembershipLive` is provided INTO the
 * permissions build (not merged beside it): `permissionsService`
 * resolves the port via `serviceOption` at layer-build time, and
 * sibling layers in a `mergeAll` are invisible to each other. */
const RbacPermissionsLive = Layer.unwrap(
	Effect.map(permissionsService, (permissions) =>
		Layer.mergeAll(
			Layer.succeed(Permissions, permissions),
			Layer.succeed(
				PermissionInvalidator,
				PermissionInvalidator.of({ invalidate: () => permissions.invalidate() }),
			),
		),
	),
).pipe(Layer.provide(GroupMembershipLive));

/** Every mutating handler bumps the permission epoch so cached grant
 * sets re-resolve on the next request. */
const withEpoch = <A, E, R>(write: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const db = yield* Db;
		const result = yield* write;
		yield* Effect.promise(() => bumpEpoch(db));
		return result;
	});

const requireAdmin = Effect.gen(function* () {
	const platformAdmin = yield* PlatformAdmin;
	yield* platformAdmin.requireAdmin();
});

export const RbacQueriesLive = Query.handlersOf(RbacQueries, {
	"rbac.catalog": () =>
		Effect.gen(function* () {
			yield* requireAdmin;
			return PERMISSION_CATALOG.map((key) => {
				const { resource, action } = splitPermission(key);
				return { key, resource, action };
			});
		}),
	"rbac.roles": () =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			const rows = yield* Effect.promise(() => listRoles(db));
			return rows.map(toRoleRow);
		}),
	"rbac.role": ({ id }) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			const role = yield* Effect.promise(() => getRole(db, id));
			if (role === null) return null;
			const perms = yield* Effect.promise(() => listRolePermissions(db, id));
			return {
				role: toRoleRow(role),
				permissions: perms.map((p) => ({
					id: p.id,
					roleId: p.roleId,
					resource: p.resource,
					action: p.action,
					effect: p.effect as PermissionEffect,
				})),
			};
		}),
	"rbac.assignments": () =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			const rows = yield* Effect.promise(() => listAssignments(db));
			return rows.map((r) => ({
				id: r.id,
				subjectKind: r.subjectKind as SubjectKind,
				subjectId: r.subjectId,
				roleId: r.roleId,
				roleName: r.roleName,
				tenantId: r.tenantId,
				grantedBy: r.grantedBy,
				expiresAt: r.expiresAt,
			}));
		}),
});

const grantedBy = Effect.gen(function* () {
	const principal = yield* Principal;
	return principal?.userId ?? null;
});

export const RbacCommandsLive = Command.handlersOf(RbacCommands, {
	"rbac.createRole": ({ name, description, meta }) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			const row = yield* withEpoch(
				Effect.promise(() => createRole(db, { name, description, meta })),
			);
			if (row === null) {
				return yield* Effect.fail(new Forbidden({ path: "rbac.createRole" }));
			}
			yield* audit({
				action: "rbac.role.create",
				targetType: "role",
				targetId: row.id,
				detail: { name: row.name },
			});
			return toRoleRow(row);
		}),
	"rbac.updateRole": ({ id, name, description, meta }) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			const row = yield* withEpoch(
				Effect.promise(() => updateRole(db, { id, name, description, meta })),
			);
			if (row !== null) {
				// Only the provided fields land in detail — JSON.stringify
				// drops the undefined keys.
				yield* audit({
					action: "rbac.role.update",
					targetType: "role",
					targetId: id,
					detail: { name, description, meta },
				});
			}
			return row === null ? null : toRoleRow(row);
		}),
	"rbac.deleteRole": ({ id }) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			yield* withEpoch(Effect.promise(() => deleteRole(db, id)));
			yield* audit({ action: "rbac.role.delete", targetType: "role", targetId: id });
		}),
	"rbac.setRolePermission": ({ roleId, resource, action, effect }) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			// Role must exist — grants on dangling roles resolve to nothing.
			const role = yield* Effect.promise(() => getRole(db, roleId));
			if (role === null) {
				return yield* Effect.fail(new Forbidden({ path: "rbac.setRolePermission" }));
			}
			yield* withEpoch(
				Effect.promise(() => setRolePermission(db, { roleId, resource, action, effect })),
			);
			yield* audit({
				action: "rbac.permission.set",
				targetType: "role",
				targetId: roleId,
				detail: { resource, action, effect },
			});
		}),
	"rbac.revokeRolePermission": ({ roleId, resource, action }) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			yield* withEpoch(
				Effect.promise(() => revokeRolePermission(db, { roleId, resource, action })),
			);
			yield* audit({
				action: "rbac.permission.revoke",
				targetType: "role",
				targetId: roleId,
				detail: { resource, action },
			});
		}),
	"rbac.assignSubject": ({ subjectKind, subjectId, roleId, tenantId, expiresAt }) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			const by = yield* grantedBy;
			const role = yield* Effect.promise(() => getRole(db, roleId));
			if (role === null) {
				return yield* Effect.fail(new Forbidden({ path: "rbac.assignSubject" }));
			}
			const row = yield* withEpoch(
				Effect.promise(() =>
					assignSubject(db, {
						subjectKind,
						subjectId,
						roleId,
						tenantId,
						expiresAt,
						grantedBy: by,
					}),
				),
			);
			if (row === null) {
				return yield* Effect.fail(new Forbidden({ path: "rbac.assignSubject" }));
			}
			yield* audit({
				action: "rbac.subject.assign",
				targetType: "subject_role",
				targetId: row.id,
				tenantId: row.tenantId,
				detail: {
					subjectKind: row.subjectKind,
					subjectId: row.subjectId,
					roleId: row.roleId,
					roleName: row.roleName,
				},
			});
			return {
				id: row.id,
				subjectKind: row.subjectKind as SubjectKind,
				subjectId: row.subjectId,
				roleId: row.roleId,
				roleName: row.roleName,
				tenantId: row.tenantId,
				grantedBy: row.grantedBy,
				expiresAt: row.expiresAt,
			};
		}),
	"rbac.unassignSubject": ({ id }) =>
		Effect.gen(function* () {
			yield* requireAdmin;
			const db = yield* Db;
			// Read before delete — the audit detail names what was revoked.
			const before = yield* Effect.promise(() => getSubjectRole(db, id));
			yield* withEpoch(Effect.promise(() => unassignSubject(db, id)));
			yield* audit({
				action: "rbac.subject.unassign",
				targetType: "subject_role",
				targetId: id,
				tenantId: before?.tenantId ?? null,
				detail:
					before === null
						? null
						: {
								subjectKind: before.subjectKind,
								subjectId: before.subjectId,
								roleId: before.roleId,
							},
			});
		}),
});

/** Built-in `superadmin` role seed (./seed.ts): runs once at layer
 * build, idempotent and create-only — inserts the role with its full
 * catalog grant set when the name is absent, then bumps the permission
 * epoch. An existing role is never repaired: revoked grants stay
 * revoked across boots. Best-effort like the i18n seed: a deployment
 * whose schema predates the rbac tables logs a warning instead of
 * failing the whole services layer (rbac queries still fail loudly on
 * use). */
const SuperadminSeedLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const db = yield* Db;
		const result = yield* Effect.promise(() => ensureSuperadminRole(db)).pipe(
			Effect.catchCause(() => Effect.logWarning("superadmin role seed failed — skipping")),
		);
		// "custom": an operator-owned role squats the name — the seed
		// leaves it alone, but the collision is worth a boot warning.
		if (result === "custom") {
			yield* Effect.logWarning(
				`a non-system role named "${SUPERADMIN_ROLE_NAME}" exists — ` +
					"the built-in superadmin seed is skipped; rename or delete it to restore",
			);
		}
	}),
);

export const rbacServicesPlugin = definePlugin({
	id: "rbac.services",
	meta: { keywords: ["rbac", "services"] },
	// Admin ops consume the PlatformAdmin gate — the dep edge keeps the
	// platform module ordered (and discovered) before this plugin's layer.
	requiredDeps: [platformAdminPlugin.id],
	// Audit writes resolve the Audit service via serviceOption — the dep
	// edge is an ordering hint only; absence is legal.
	optionalDeps: [auditServicesPlugin.id],
	services: Layer.mergeAll(
		RbacPermissionsLive,
		GroupMembershipLive,
		RbacQueriesLive,
		RbacCommandsLive,
		SuperadminSeedLive,
	),
});

export const rbacTablesPlugin = definePlugin({
	id: "rbac.tables",
	meta: { keywords: ["rbac", "tables"] },
	tables: {
		roles,
		relationTuples,
		permissionEpoch,
	},
});

// Chrome contribution (P-060): the console sidebar entry lives in the
// `portal.sidebar` chrome region; the dep edge orders it after the
// shell like the retired panel entry.
export const rbacChromePlugin = definePlugin({
	i18nKeys: {
		groups: { Identity: "panel_group_identity" },
	},
	id: "rbac.chrome",
	meta: { keywords: ["rbac", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "rbac.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/roles", label: "Roles", icon: ShieldCheckIcon, group: "Identity" },
			},
		},
	],
});

// Panel (system console) contribution: /platform/roles is mounted by
// the platform plugin's physical route subtree; this plugin declares
// the page descriptor.
export const rbacPanelPlugin = definePlugin({
	id: "rbac.panel",
	meta: { keywords: ["rbac", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	panel: {
		pages: [
			{
				id: "rbac.admin",
				path: "/platform/roles",
				component: RbacPlatformPage,
				// Cross-owner admin data — every query re-checks the
				// PlatformAdmin gate; Forbidden collapses to the empty
				// console like the other admin pages.
				loader: () =>
					// `Query.dispatcher` requires `Scope` — `runAs` does not
					// provide one, so the dispatch surface is built inside a
					// scoped region like the server fns do.
					Effect.scoped(
						Effect.gen(function* () {
							const queries = yield* Query.dispatcher(RbacQueries);
							const empty: AdminRbacPageData = {
								roles: [],
								details: [],
								assignments: [],
								catalog: [],
							};
							return yield* Effect.gen(function* () {
								const [roles, assignments, catalog] = yield* Effect.all([
									queries["rbac.roles"]({}),
									queries["rbac.assignments"]({}),
									queries["rbac.catalog"]({}),
								]);
								const details = yield* Effect.forEach(roles, (r) =>
									queries["rbac.role"]({ id: r.id }),
								);
								return {
									roles,
									details: details.filter((d) => d !== null),
									assignments,
									catalog,
								};
							}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed(empty)));
						}),
					),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	rbacTablesPlugin,
	rbacServicesPlugin,
	rbacChromePlugin,
	rbacPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"rbac.tables": true;
		"rbac.services": true;
		"rbac.chrome": true;
		"rbac.panel": true;
	}
}
