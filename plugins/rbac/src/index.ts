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
	PERMISSION_CATALOG,
	splitPermission,
	subjectRoles,
	rolePermissions,
	roles,
	permissionEpoch,
	type PermissionEffect,
	type Role,
	type RolePermission,
	type SubjectKind,
	type SubjectRole,
} from "@ktb/rbac";
import { Command, Query } from "@effect-server-utils/cqrs";

import { relationTuples } from "@ktb/db/schema";
import { RbacCommands, RbacQueries } from "./api.ts";
import { RbacPlatformPage } from "./platform-page.tsx";
import { ensureSuperadminRole, SUPERADMIN_ROLE_NAME } from "./seed.ts";

// ---------- row shapes ----------

export type { Role, RolePermission, SubjectRole };

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

export async function listRoles(db: DbClient): Promise<Role[]> {
	return db.select().from(roles).orderBy(roles.name);
}

export async function getRole(db: DbClient, id: number): Promise<Role | null> {
	const rows = await db.select().from(roles).where(eq(roles.id, id));
	return rows[0] ?? null;
}

export async function listRolePermissions(db: DbClient, roleId: number) {
	return db.select().from(rolePermissions).where(eq(rolePermissions.roleId, roleId));
}

export async function listAssignments(db: DbClient): Promise<AssignmentRow[]> {
	const rows = await db
		.select({ assignment: subjectRoles, roleName: roles.name })
		.from(subjectRoles)
		.innerJoin(roles, eq(roles.id, subjectRoles.roleId))
		.orderBy(desc(subjectRoles.id));
	return rows.map((r) => ({ ...r.assignment, roleName: r.roleName }));
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

export async function setRolePermission(
	db: DbClient,
	input: { roleId: number; resource: string; action: string; effect: PermissionEffect },
): Promise<void> {
	// P-101: grant tuples key on the role NAME — resolve it once for
	// both writes. A missing role leaves a dangling role_permissions
	// row (resolves to nothing) and no tuple, matching prior semantics.
	const role = await getRole(db, input.roleId);
	await db
		.insert(rolePermissions)
		.values({
			roleId: input.roleId,
			resource: input.resource,
			action: input.action,
			effect: input.effect,
			createdAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [rolePermissions.roleId, rolePermissions.resource, rolePermissions.action],
			set: { effect: input.effect },
		});
	if (role !== null) {
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
	}
}

export async function revokeRolePermission(
	db: DbClient,
	input: { roleId: number; resource: string; action: string },
): Promise<void> {
	await db
		.delete(rolePermissions)
		.where(
			and(
				eq(rolePermissions.roleId, input.roleId),
				eq(rolePermissions.resource, input.resource),
				eq(rolePermissions.action, input.action),
			),
		);
	// P-101: drop the mirrored grant tuple (role name lookup needed —
	// tuples key on name, not id).
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
}

const normalizeExpiresAt = (input: Date | string | number | null | undefined): Date | null => {
	if (input === null || input === undefined) return null;
	const d = input instanceof Date ? input : new Date(input);
	return Number.isNaN(d.getTime()) ? null : d;
};

/** Find an existing assignment for the same (subject, role, tenant)
 * triple — tenant NULL matches only NULL (SQL `=` never matches NULL,
 * so global grants are checked separately). */
async function findAssignment(
	db: DbClient,
	input: {
		subjectKind: SubjectKind;
		subjectId: string;
		roleId: number;
		tenantId?: string | number | null;
	},
): Promise<SubjectRole | null> {
	// TEXT column; P-053 tenant ids are string|number — normalize.
	const tenantId = input.tenantId == null ? null : String(input.tenantId);
	const rows = await db
		.select()
		.from(subjectRoles)
		.where(
			and(
				eq(subjectRoles.subjectKind, input.subjectKind),
				eq(subjectRoles.subjectId, input.subjectId),
				eq(subjectRoles.roleId, input.roleId),
				tenantId === null
					? sql`${subjectRoles.tenantId} is null`
					: eq(subjectRoles.tenantId, tenantId),
			),
		);
	return rows[0] ?? null;
}

// ---------- relation tuples (P-101 dual-write) ----------

/** Tenant predicate shared by tuple reads/writes — mirrors
 * `findAssignment`: NULL tenantId matches only NULL rows (SQL `=`
 * never matches NULL, so global tuples are checked separately). */
const tupleTenant = (tenantId: string | null) =>
	tenantId === null
		? sql`${relationTuples.tenantId} is null`
		: eq(relationTuples.tenantId, tenantId);

/**
 * P-101: `relation_tuples` is the Zanzibar-style grant graph the
 * permission resolver reads; `role_permissions`/`subject_roles` stay
 * the admin-facing store. Every repo write mirrors its change here so
 * ALL callers — CQRS handlers, server fns, seeds, scripts — stay in
 * sync. Natural-key uniqueness is enforced by this find-then-write
 * (tenant_id NULLs are distinct in SQLite — same caveat as
 * `subject_roles`; see schema.ts).
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
	const expiresAt = normalizeExpiresAt(input.expiresAt);
	const existing = await findAssignment(db, input);
	let row: SubjectRole | undefined;
	if (existing !== null) {
		// Re-assigning the same triple refreshes expiry/granter in place.
		const rows = await db
			.update(subjectRoles)
			.set({ expiresAt, grantedBy: input.grantedBy ?? existing.grantedBy })
			.where(eq(subjectRoles.id, existing.id))
			.returning();
		row = rows[0];
	} else {
		const rows = await db
			.insert(subjectRoles)
			.values({
				subjectKind: input.subjectKind,
				subjectId: input.subjectId,
				roleId: input.roleId,
				tenantId: input.tenantId == null ? null : String(input.tenantId),
				grantedBy: input.grantedBy ?? null,
				expiresAt,
				createdAt: new Date(),
			})
			.returning();
		row = rows[0];
	}
	if (row === undefined) return null;
	const role = await getRole(db, row.roleId);
	if (role !== null) {
		// P-101: mirror the assignment as a member tuple keyed on the
		// role NAME; row fields already reflect the refreshed
		// expiry/granter, so re-assigns update the tuple in place.
		await upsertRelationTuple(db, {
			objectType: "role",
			objectId: role.name,
			relation: "member",
			subjectKind: row.subjectKind,
			subjectId: row.subjectId,
			effect: "allow",
			tenantId: row.tenantId,
			expiresAt: row.expiresAt,
			grantedBy: row.grantedBy,
		});
	}
	return { ...row, roleName: role?.name ?? "" };
}

export async function unassignSubject(db: DbClient, id: number): Promise<void> {
	// P-101: read the row first — the member tuple keys on role NAME
	// and subject/tenant, none of which the bare id carries.
	const row = await getSubjectRole(db, id);
	await db.delete(subjectRoles).where(eq(subjectRoles.id, id));
	if (row === null) return;
	const role = await getRole(db, row.roleId);
	if (role === null) return;
	await db
		.delete(relationTuples)
		.where(
			and(
				eq(relationTuples.objectType, "role"),
				eq(relationTuples.objectId, role.name),
				eq(relationTuples.relation, "member"),
				eq(relationTuples.subjectKind, row.subjectKind),
				eq(relationTuples.subjectId, row.subjectId),
				tupleTenant(row.tenantId),
			),
		);
}

/** Single assignment lookup by row id — the audit path reads the row
 * before `unassignSubject` deletes it. */
export async function getSubjectRole(db: DbClient, id: number): Promise<SubjectRole | null> {
	const rows = await db.select().from(subjectRoles).where(eq(subjectRoles.id, id));
	return rows[0] ?? null;
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
		rolePermissions,
		subjectRoles,
		relationTuples,
		permissionEpoch,
	},
});

// Chrome contribution (P-060): the console sidebar entry lives in the
// `portal.sidebar` chrome region; the dep edge orders it after the
// shell like the retired panel entry.
export const rbacChromePlugin = definePlugin({
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
