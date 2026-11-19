import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Command, Query } from "@effect-server-utils/cqrs";
import { adminAudit, AUDIT_TEST_DDL, AuditLive } from "@ktb/audit";
import { Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { GroupMembership, Permissions, PermissionInvalidator, readEpoch } from "@ktb/rbac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ShieldCheckIcon } from "lucide-react";

import {
	assignSubject,
	createRole,
	deleteRole,
	getRole,
	groupIdsForUser,
	listAssignments,
	listRolePermissions,
	listRoles,
	plugins,
	rbacChromePlugin,
	rbacPanelPlugin,
	rbacServicesPlugin,
	rbacTablesPlugin,
	revokeRolePermission,
	setRolePermission,
	unassignSubject,
	updateRole,
	type AdminRbacPageData,
} from "./index.ts";
import { relationTuples as relationTuplesTable, roles as rolesTable } from "@ktb/db/schema";
import { RbacCommands, RbacQueries } from "./api.ts";

const DDL = `
CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE role_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, resource TEXT NOT NULL, action TEXT NOT NULL, effect TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX role_permissions_role_resource_action_idx ON role_permissions (role_id, resource, action);
CREATE TABLE subject_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, tenant_id TEXT, granted_by TEXT, expires_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX subject_roles_subject_idx ON subject_roles (subject_kind, subject_id);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
CREATE INDEX relation_tuples_object_idx ON relation_tuples (object_type, object_id, relation);
CREATE INDEX relation_tuples_subject_idx ON relation_tuples (subject_kind, subject_id);
CREATE INDEX relation_tuples_natural_idx ON relation_tuples (object_type, object_id, relation, subject_kind, subject_id);
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, zk INTEGER NOT NULL DEFAULT 0);
CREATE TABLE group_members (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, member_kind TEXT NOT NULL, member_id TEXT NOT NULL, role TEXT, created_at INTEGER NOT NULL);
INSERT INTO groups (id, name, slug, kind, meta, created_at, updated_at) VALUES (7, 'Clinic', 'clinic', 'clinic', NULL, 1, 1);
INSERT INTO group_members (group_id, member_kind, member_id, role, created_at) VALUES (7, 'user', 'u1', NULL, 1), (7, 'patient', 'p1', NULL, 1);
${AUDIT_TEST_DDL}
`;

const ADMIN = { userId: "admin@x.com", email: "admin@x.com" };
const MEMBER = { userId: "user@x.com", email: "user@x.com" };

const adminGate = makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"));

/** A DbClient stub for the defensive empty-RETURNING paths real
 * drivers never produce: `selects` is a queue of row arrays consumed
 * by `where()`/`orderBy()` terminals in call order, `insertRows` is
 * what `insert(...).values(...).returning()` resolves with. The same
 * `values()` also answers `onConflictDoUpdate` (epoch bumps). */
const fakeDb = (opts: {
	readonly selects?: readonly unknown[][];
	readonly insertRows?: readonly unknown[];
}): DbClient => {
	const selects = [...(opts.selects ?? [])];
	return {
		select: () => ({
			from: () => ({
				where: async () => selects.shift() ?? [],
				orderBy: async () => selects.shift() ?? [],
				innerJoin: () => ({ orderBy: async () => selects.shift() ?? [] }),
			}),
		}),
		insert: () => ({
			values: () => ({
				returning: async () => opts.insertRows ?? [],
				onConflictDoUpdate: async () => [],
				// The superadmin seed's role insert — empty result simulates
				// losing the create race (seed then no-ops).
				onConflictDoNothing: () => ({
					returning: async () => opts.insertRows ?? [],
				}),
			}),
		}),
		update: () => ({
			set: () => ({
				where: () => ({
					// Empty result simulates an UPDATE that matched no row
					// (the defensive `rows[0] ?? null` path).
					returning: async () => [],
				}),
			}),
		}),
		delete: () => ({
			where: async () => [],
		}),
	} as unknown as DbClient;
};

describe("rbac repo", () => {
	let db: DbClient;

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
	});

	it("role CRUD round-trips", async () => {
		const created = await createRole(db, {
			name: "nurse",
			description: "Ward",
			meta: '{"x":1}',
		});
		expect(created).not.toBeNull();
		expect(created!.name).toBe("nurse");
		expect((await listRoles(db)).map((r) => r.name)).toEqual(["nurse"]);

		const updated = await updateRole(db, { id: created!.id, description: "ICU" });
		expect(updated?.description).toBe("ICU");
		// No-op patch returns the row unchanged.
		const same = await updateRole(db, { id: created!.id });
		expect(same?.name).toBe("nurse");
		expect(await updateRole(db, { id: 999, name: "ghost" })).toBeNull();
		expect(await getRole(db, 999)).toBeNull();

		await deleteRole(db, created!.id);
		expect(await getRole(db, created!.id)).toBeNull();
	});

	it("setRolePermission upserts effect, revoke removes", async () => {
		const role = (await createRole(db, { name: "billing" }))!;
		await setRolePermission(db, {
			roleId: role.id,
			resource: "billing",
			action: "manage",
			effect: "allow",
		});
		let perms = await listRolePermissions(db, role.id);
		expect(perms).toHaveLength(1);
		expect(perms[0]?.effect).toBe("allow");

		// Same triple flips to deny in place.
		await setRolePermission(db, {
			roleId: role.id,
			resource: "billing",
			action: "manage",
			effect: "deny",
		});
		perms = await listRolePermissions(db, role.id);
		expect(perms).toHaveLength(1);
		expect(perms[0]?.effect).toBe("deny");

		// P-101: the grant tuple mirrors the permission keyed on the
		// role NAME with the "*" object wildcard.
		let tuples = await db.select().from(relationTuplesTable);
		const grant = tuples.find(
			(t) =>
				t.objectType === "billing" &&
				t.objectId === "*" &&
				t.relation === "manage" &&
				t.subjectKind === "role" &&
				t.subjectId === "billing",
		);
		expect(grant).toMatchObject({ effect: "deny", tenantId: null });

		await revokeRolePermission(db, {
			roleId: role.id,
			resource: "billing",
			action: "manage",
		});
		expect(await listRolePermissions(db, role.id)).toHaveLength(0);
		tuples = await db.select().from(relationTuplesTable);
		expect(
			tuples.some(
				(t) =>
					t.objectType === "billing" &&
					t.relation === "manage" &&
					t.subjectKind === "role" &&
					t.subjectId === "billing",
			),
		).toBe(false);
		// Revoking a missing grant is a no-op.
		await revokeRolePermission(db, {
			roleId: role.id,
			resource: "billing",
			action: "manage",
		});

		// deleteRole drops every tuple shape carrying the role name.
		await setRolePermission(db, {
			roleId: role.id,
			resource: "billing",
			action: "read",
			effect: "allow",
		});
		await assignSubject(db, {
			subjectKind: "user",
			subjectId: "u-billing",
			roleId: role.id,
		});
		await deleteRole(db, role.id);
		tuples = await db.select().from(relationTuplesTable);
		expect(tuples.some((t) => t.subjectId === "billing" || t.objectId === "billing")).toBe(false);
	});

	it("assignSubject inserts, refreshes and scopes by tenant", async () => {
		const role = (await createRole(db, { name: "auditor" }))!;
		const a1 = await assignSubject(db, {
			subjectKind: "user",
			subjectId: "u1",
			roleId: role.id,
			tenantId: null,
			expiresAt: null,
			grantedBy: "admin",
		});
		expect(a1?.roleName).toBe("auditor");
		expect(a1?.tenantId).toBeNull();

		// Same (subject, role, tenant) triple refreshes in place.
		const a2 = await assignSubject(db, {
			subjectKind: "user",
			subjectId: "u1",
			roleId: role.id,
			tenantId: null,
			expiresAt: "2030-01-01T00:00:00.000Z",
			grantedBy: "admin2",
		});
		expect(a2?.id).toBe(a1?.id);
		expect(a2?.expiresAt).toBeInstanceOf(Date);
		expect(a2?.grantedBy).toBe("admin2");

		// P-101: the member tuple mirrors the refreshed assignment —
		// role NAME in object_id, assignee in subject_*, tenant NULL.
		const tuples = await db.select().from(relationTuplesTable);
		const member = tuples.find(
			(t) => t.objectId === "auditor" && t.subjectId === "u1" && t.relation === "member",
		);
		expect(member).toMatchObject({
			objectType: "role",
			subjectKind: "user",
			effect: "allow",
			tenantId: null,
			grantedBy: "admin2",
		});
		expect(member?.expiresAt).toBeInstanceOf(Date);

		// Numeric tenant id normalizes to the TEXT column.
		const a3 = await assignSubject(db, {
			subjectKind: "group",
			subjectId: "7",
			roleId: role.id,
			tenantId: 42,
		});
		expect(a3?.tenantId).toBe("42");

		// Garbage expiresAt normalizes to null (never expires).
		const a4 = await assignSubject(db, {
			subjectKind: "user",
			subjectId: "u2",
			roleId: role.id,
			expiresAt: "not-a-date",
		});
		expect(a4?.expiresAt).toBeNull();

		const assignments = await listAssignments(db);
		expect(assignments.length).toBeGreaterThanOrEqual(3);
		expect(assignments.every((a) => a.roleName === "auditor")).toBe(true);

		await unassignSubject(db, a1!.id);
		expect((await listAssignments(db)).some((a) => a.id === a1!.id)).toBe(false);
		// The member tuple went with it.
		const afterUnassign = await db.select().from(relationTuplesTable);
		expect(
			afterUnassign.some(
				(t) => t.objectId === "auditor" && t.subjectId === "u1" && t.relation === "member",
			),
		).toBe(false);
	});

	it("updateRole rename rewrites tuple role references (P-101)", async () => {
		const role = (await createRole(db, { name: "old-name" }))!;
		await setRolePermission(db, {
			roleId: role.id,
			resource: "patient",
			action: "read",
			effect: "allow",
		});
		await assignSubject(db, {
			subjectKind: "user",
			subjectId: "u-rename",
			roleId: role.id,
		});
		const renamed = await updateRole(db, { id: role.id, name: "new-name" });
		expect(renamed?.name).toBe("new-name");
		const tuples = await db.select().from(relationTuplesTable);
		// Grant tuples carry the role name in subject_id…
		const grant = tuples.find(
			(t) => t.objectType === "patient" && t.relation === "read" && t.subjectKind === "role",
		);
		expect(grant?.subjectId).toBe("new-name");
		// …member tuples in object_id.
		const member = tuples.find((t) => t.subjectId === "u-rename" && t.relation === "member");
		expect(member?.objectId).toBe("new-name");

		// Re-"renaming" to the same name is a no-op: the row comes back
		// and no tuple rewrite runs.
		const same = await updateRole(db, { id: role.id, name: "new-name" });
		expect(same?.name).toBe("new-name");
	});

	it("tolerates missing rows and dangling role ids", async () => {
		// deleteRole on a nonexistent id: no role row → no tuple sweep.
		await deleteRole(db, 999);

		// The dangling-roleId paths below need rows real FK enforcement
		// would reject, so they run against the stub driver: the repo
		// fns still resolve — role_permissions writes land, tuple
		// writes/reads keyed on the role NAME are skipped.

		// setRolePermission: getRole → [] → role_permissions insert
		// still runs, the grant-tuple upsert is skipped.
		await expect(
			setRolePermission(fakeDb({ selects: [[]] }), {
				roleId: 999,
				resource: "ghost",
				action: "read",
				effect: "allow",
			}),
		).resolves.toBeUndefined();

		// revokeRolePermission: delete runs, getRole → [] → early
		// return before the tuple delete.
		await expect(
			revokeRolePermission(fakeDb({ selects: [[]] }), {
				roleId: 999,
				resource: "ghost",
				action: "read",
			}),
		).resolves.toBeUndefined();

		// unassignSubject: the subject_roles row exists but its
		// roleId dangles — row deleted, member-tuple sweep skipped.
		// getSubjectRole → [row], getRole → [].
		const assignment = {
			id: 7,
			subjectKind: "user",
			subjectId: "u-dangling",
			roleId: 999,
			tenantId: null,
			grantedBy: null,
			expiresAt: null,
			createdAt: new Date(0),
		};
		await expect(
			unassignSubject(fakeDb({ selects: [[assignment], []] }), 7),
		).resolves.toBeUndefined();
	});

	it("groupIdsForUser reads group_members without importing groups", async () => {
		expect(await groupIdsForUser(db, "u1")).toEqual(["7"]);
		expect(await groupIdsForUser(db, "nobody")).toEqual([]);
	});

	it("updateRole patches meta and assignSubject refresh keeps grantedBy", async () => {
		const role = (await createRole(db, { name: "meta-role" }))!;
		const updated = await updateRole(db, { id: role.id, meta: '{"a":1}' });
		expect(updated?.meta).toBe('{"a":1}');

		const exp = new Date("2031-05-05T00:00:00.000Z");
		const a1 = await assignSubject(db, {
			subjectKind: "user",
			subjectId: "u7",
			roleId: role.id,
			expiresAt: exp,
			grantedBy: "first",
		});
		expect(a1?.expiresAt?.getTime()).toBe(exp.getTime());

		// Refresh without grantedBy/expiresAt inputs keeps the stored
		// granter and clears the expiry.
		const a2 = await assignSubject(db, {
			subjectKind: "user",
			subjectId: "u7",
			roleId: role.id,
		});
		expect(a2?.id).toBe(a1?.id);
		expect(a2?.grantedBy).toBe("first");
		expect(a2?.expiresAt).toBeNull();
	});
});

describe("rbac repo — empty-driver paths", () => {
	it("createRole returns null when RETURNING yields no row", async () => {
		expect(await createRole(fakeDb({}), { name: "ghost" })).toBeNull();
	});

	it("assignSubject returns null when the insert RETURNING yields no row", async () => {
		const result = await assignSubject(fakeDb({ selects: [[]] }), {
			subjectKind: "user",
			subjectId: "u",
			roleId: 1,
		});
		expect(result).toBeNull();
	});

	it("updateRole returns null when UPDATE ... RETURNING yields no row", async () => {
		const role = {
			id: 1,
			name: "auditor",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		};
		// Name patch → getRole consumes [role]; the UPDATE itself
		// returns no rows (row vanished between read and write).
		const result = await updateRole(fakeDb({ selects: [[role]] }), {
			id: 1,
			name: "renamed",
		});
		expect(result).toBeNull();
	});

	it("assignSubject reports an empty roleName when the role row is gone", async () => {
		const row = {
			id: 1,
			subjectKind: "user",
			subjectId: "u-ghost",
			roleId: 999,
			tenantId: null,
			grantedBy: null,
			expiresAt: null,
			createdAt: new Date(0),
		};
		const result = await assignSubject(fakeDb({ selects: [[], []], insertRows: [[row]] }), {
			subjectKind: "user",
			subjectId: "u-ghost",
			roleId: 999,
		});
		expect(result?.roleName).toBe("");
	});
});

describe("rbac services + CQRS", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let db: DbClient;

	const asUser = <A, E>(
		user: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		runtime.runPromise(
			effect.pipe(
				Effect.provideService(
					Principal,
					user === null ? null : { userId: user.userId, email: user.email },
				),
			),
		);

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		await db.insert(rolesTable).values({
			name: "auditor",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		const env = Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, adminGate));
		// Provide the real audit service so admin commands write
		// admin_audit rows (T-037); the empty-driver describes below
		// intentionally omit it to cover the optional-absent path.
		const envWithAudit = Layer.mergeAll(env, AuditLive.pipe(Layer.provide(env)));
		// The plugin's services layer is type-erased (Layer.Any) — same
		// treatment the composition root gives it.
		const services = rbacServicesPlugin.services as Layer.Layer<unknown, unknown, unknown>;
		runtime = ManagedRuntime.make(
			services.pipe(Layer.provideMerge(envWithAudit)) as unknown as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
	});

	afterAll(() => runtime.dispose());

	it("queries and commands enforce the PlatformAdmin gate", async () => {
		const program = Effect.gen(function* () {
			const queries = yield* Query.dispatcher(RbacQueries);
			return yield* queries["rbac.roles"]({});
		});
		// Non-admin principal → Forbidden.
		await expect(asUser(MEMBER, program.pipe(Effect.scoped))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		// Admin → rows.
		const rows = await asUser(ADMIN, program.pipe(Effect.scoped));
		expect(rows.map((r) => r.name)).toContain("auditor");
	});

	it("full role lifecycle through the command dispatcher", async () => {
		const out = await asUser(
			ADMIN,
			Effect.scoped(
				Effect.gen(function* () {
					const commands = yield* Command.dispatcher(RbacCommands);
					const queries = yield* Query.dispatcher(RbacQueries);
					const role = yield* commands["rbac.createRole"]({
						name: "receptionist",
						description: "Front desk",
					});
					yield* commands["rbac.setRolePermission"]({
						roleId: role.id,
						resource: "patient",
						action: "read",
						effect: "allow",
					});
					const assignment = yield* commands["rbac.assignSubject"]({
						subjectKind: "user",
						subjectId: "u9",
						roleId: role.id,
						tenantId: "clinic-1",
					});
					const detail = yield* queries["rbac.role"]({ id: role.id });
					const assignments = yield* queries["rbac.assignments"]({});
					const catalog = yield* queries["rbac.catalog"]({});
					return { role, assignment, detail, assignments, catalog };
				}),
			),
		);
		expect(out.role.name).toBe("receptionist");
		expect(out.assignment.grantedBy).toBe("admin@x.com");
		expect(out.assignment.tenantId).toBe("clinic-1");
		expect(out.detail?.permissions).toHaveLength(1);
		expect(out.assignments.some((a) => a.id === out.assignment.id)).toBe(true);
		expect(out.catalog.some((c) => c.key === "patient.read")).toBe(true);
		// Writes bumped the epoch.
		expect(await readEpoch(db)).toBeGreaterThan(0);
	});

	it("admin commands write audit rows for the full lifecycle", async () => {
		const out = await asUser(
			ADMIN,
			Effect.scoped(
				Effect.gen(function* () {
					const commands = yield* Command.dispatcher(RbacCommands);
					const role = yield* commands["rbac.createRole"]({ name: "audited-role" });
					yield* commands["rbac.updateRole"]({ id: role.id, description: "Audited" });
					yield* commands["rbac.setRolePermission"]({
						roleId: role.id,
						resource: "patient",
						action: "read",
						effect: "allow",
					});
					const assignment = yield* commands["rbac.assignSubject"]({
						subjectKind: "user",
						subjectId: "u-audit",
						roleId: role.id,
						tenantId: "7",
					});
					yield* commands["rbac.revokeRolePermission"]({
						roleId: role.id,
						resource: "patient",
						action: "read",
					});
					yield* commands["rbac.unassignSubject"]({ id: assignment.id });
					yield* commands["rbac.deleteRole"]({ id: role.id });
					return { roleId: role.id, assignmentId: assignment.id };
				}),
			),
		);
		const rows = await db.select().from(adminAudit);
		const byAction = (action: string) => rows.filter((r) => r.action === action);
		// Earlier tests in this describe also write audit rows — scope
		// every count to this test's role/assignment.
		const forRole = (action: string) =>
			byAction(action).filter((r) => r.targetId === String(out.roleId));
		expect(forRole("rbac.role.create")).toHaveLength(1);
		expect(forRole("rbac.role.update")).toHaveLength(1);
		expect(forRole("rbac.permission.set")).toHaveLength(1);
		expect(forRole("rbac.permission.revoke")).toHaveLength(1);
		expect(forRole("rbac.role.delete")).toHaveLength(1);
		expect(byAction("rbac.subject.assign").map((r) => r.targetId)).toContain(
			String(out.assignmentId),
		);
		expect(byAction("rbac.subject.unassign").map((r) => r.targetId)).toContain(
			String(out.assignmentId),
		);
		const created = forRole("rbac.role.create")[0]!;
		expect(created).toMatchObject({
			actorUserId: "admin@x.com",
			actorEmail: "admin@x.com",
			targetType: "role",
		});
		const assigned = byAction("rbac.subject.assign").find(
			(r) => r.targetId === String(out.assignmentId),
		)!;
		expect(assigned.tenantId).toBe(7);
	});

	it("denies commands for unknown roles and non-admins", async () => {
		await expect(
			asUser(
				ADMIN,
				Effect.scoped(
					Effect.gen(function* () {
						const commands = yield* Command.dispatcher(RbacCommands);
						return yield* commands["rbac.setRolePermission"]({
							roleId: 999,
							resource: "patient",
							action: "read",
							effect: "allow",
						});
					}),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		await expect(
			asUser(
				MEMBER,
				Effect.scoped(
					Effect.gen(function* () {
						const commands = yield* Command.dispatcher(RbacCommands);
						return yield* commands["rbac.deleteRole"]({ id: 1 });
					}),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("Permissions + PermissionInvalidator + GroupMembership are provided", async () => {
		const out = await runtime.runPromise(
			Effect.gen(function* () {
				const permissions = yield* Permissions;
				const invalidator = yield* PermissionInvalidator;
				const membership = yield* GroupMembership;
				const groupIds = yield* membership.groupIdsFor("u1");
				const grants = yield* permissions.permissionsFor("u1");
				return { groupIds, grants, invalidate: invalidator.invalidate };
			}),
		);
		expect(out.groupIds).toEqual(["7"]);
		// auditor role assigned? Not yet — empty grants is fine; the
		// point is the services resolve.
		expect(out.grants.size).toBe(0);
		await runtime.runPromise(out.invalidate());
	});

	it("rbac.role returns null for an unknown id", async () => {
		const detail = await asUser(
			ADMIN,
			Effect.scoped(
				Effect.gen(function* () {
					const queries = yield* Query.dispatcher(RbacQueries);
					return yield* queries["rbac.role"]({ id: 999 });
				}),
			),
		);
		expect(detail).toBeNull();
	});

	it("assignSubject fails Forbidden for an unknown role", async () => {
		await expect(
			asUser(
				ADMIN,
				Effect.scoped(
					Effect.gen(function* () {
						const commands = yield* Command.dispatcher(RbacCommands);
						return yield* commands["rbac.assignSubject"]({
							subjectKind: "user",
							subjectId: "u",
							roleId: 999,
						});
					}),
				),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("unassignSubject on a missing row audits a null detail", async () => {
		await asUser(
			ADMIN,
			Effect.scoped(
				Effect.gen(function* () {
					const commands = yield* Command.dispatcher(RbacCommands);
					yield* commands["rbac.unassignSubject"]({ id: 424242 });
				}),
			),
		);
		const rows = await db.select().from(adminAudit);
		const row = rows.find((r) => r.action === "rbac.subject.unassign" && r.targetId === "424242");
		expect(row).toMatchObject({ detail: null, tenantId: null });
	});
});

describe("rbac services — empty-driver paths", () => {
	const servicesLayer = () => rbacServicesPlugin.services as Layer.Layer<unknown, unknown, unknown>;

	const runtimeFor = (db: DbClient, gate: PlatformAdmin["Service"] = adminGate) => {
		const env = Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, gate));
		return ManagedRuntime.make(
			servicesLayer().pipe(Layer.provide(env)) as unknown as Layer.Layer<unknown, never, never>,
		);
	};

	const asPrincipal = <A, E>(
		rt: ManagedRuntime.ManagedRuntime<unknown, never>,
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		rt.runPromise(
			effect.pipe(
				Effect.provideService(
					Principal,
					principal === null ? null : { userId: principal.userId, email: principal.email },
				),
			),
		);

	it("createRole fails Forbidden when INSERT ... RETURNING yields no row", async () => {
		const rt = runtimeFor(fakeDb({}));
		try {
			await expect(
				asPrincipal(
					rt,
					ADMIN,
					Effect.scoped(
						Effect.gen(function* () {
							const commands = yield* Command.dispatcher(RbacCommands);
							return yield* commands["rbac.createRole"]({ name: "ghost" });
						}),
					),
				),
			).rejects.toMatchObject({ _tag: "Forbidden" });
		} finally {
			await rt.dispose();
		}
	});

	it("assignSubject fails Forbidden when the insert RETURNING yields no row", async () => {
		const role = {
			id: 1,
			name: "auditor",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		};
		// getRole → [role], findAssignment → [], insert RETURNING → [].
		// The leading row answers the superadmin seed's existence probe
		// at layer build (sees a role → no-op, consumes nothing else).
		const rt = runtimeFor(fakeDb({ selects: [[{ id: 1 }], [role], []] }));
		try {
			await expect(
				asPrincipal(
					rt,
					ADMIN,
					Effect.scoped(
						Effect.gen(function* () {
							const commands = yield* Command.dispatcher(RbacCommands);
							return yield* commands["rbac.assignSubject"]({
								subjectKind: "user",
								subjectId: "u",
								roleId: 1,
							});
						}),
					),
				),
			).rejects.toMatchObject({ _tag: "Forbidden" });
		} finally {
			await rt.dispose();
		}
	});

	it("superadmin seed failure logs a warning and the layer still builds", async () => {
		// A Db whose selects reject simulates a deployment whose schema
		// predates the rbac tables — the seed is best-effort: the
		// catchCause logs a warning and layer build continues.
		const brokenDb = {
			select: () => ({
				from: () => ({
					where: async () => {
						throw new Error("no such table: roles");
					},
				}),
			}),
		} as unknown as DbClient;
		const rt = runtimeFor(brokenDb);
		try {
			// Building the runtime runs the seed effect; it must not fail.
			await expect(rt.runPromise(Effect.void)).resolves.toBeUndefined();
		} finally {
			await rt.dispose();
		}
	});

	it("assignSubject records a null grantedBy without a bound principal", async () => {
		const db = makeDb(makeD1(DDL));
		await db.insert(rolesTable).values({
			name: "auditor",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		// A gate that admits everyone isolates the grantedBy null path.
		const openGate: PlatformAdmin["Service"] = {
			isAdmin: () => Effect.succeed(true),
			requireAdmin: () => Effect.void,
		};
		const rt = runtimeFor(db, openGate);
		try {
			const row = await asPrincipal(
				rt,
				null,
				Effect.scoped(
					Effect.gen(function* () {
						const commands = yield* Command.dispatcher(RbacCommands);
						return yield* commands["rbac.assignSubject"]({
							subjectKind: "user",
							subjectId: "u9",
							roleId: 1,
						});
					}),
				),
			);
			expect(row.grantedBy).toBeNull();
		} finally {
			await rt.dispose();
		}
	});
});

describe("rbac panel loader", () => {
	const servicesLayer = () => rbacServicesPlugin.services as Layer.Layer<unknown, unknown, unknown>;
	const loader = rbacPanelPlugin.panel!.pages![0]!.loader as () => Effect.Effect<
		AdminRbacPageData,
		unknown,
		unknown
	>;

	it("returns roles, details, assignments and the catalog", async () => {
		const db = makeDb(makeD1(DDL));
		await db.insert(rolesTable).values({
			name: "auditor",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		const env = Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, adminGate));
		const rt = ManagedRuntime.make(
			servicesLayer().pipe(Layer.provide(env)) as unknown as Layer.Layer<unknown, never, never>,
		);
		try {
			const data = await rt.runPromise(
				Effect.scoped(loader()).pipe(
					Effect.provideService(Principal, {
						userId: ADMIN.userId,
						email: ADMIN.email,
					}),
				),
			);
			expect(data.roles.map((r) => r.name)).toContain("auditor");
			expect(data.details).toHaveLength(data.roles.length);
			expect(data.details[0]?.permissions).toEqual([]);
			expect(data.catalog.some((c) => c.key === "patient.read")).toBe(true);
		} finally {
			await rt.dispose();
		}
	});

	it("collapses Forbidden to the empty console", async () => {
		const db = makeDb(makeD1(DDL));
		const env = Layer.mergeAll(Layer.succeed(Db, db), Layer.succeed(PlatformAdmin, adminGate));
		const rt = ManagedRuntime.make(
			servicesLayer().pipe(Layer.provide(env)) as unknown as Layer.Layer<unknown, never, never>,
		);
		try {
			const data = await rt.runPromise(
				Effect.scoped(loader()).pipe(
					Effect.provideService(Principal, {
						userId: MEMBER.userId,
						email: MEMBER.email,
					}),
				),
			);
			expect(data).toEqual({ roles: [], details: [], assignments: [], catalog: [] });
		} finally {
			await rt.dispose();
		}
	});

	it("drops roles whose detail query returns null", async () => {
		const role = {
			id: 1,
			name: "auditor",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		};
		// rbac.roles → [role], rbac.assignments → [], rbac.role → null.
		// Leading row: the superadmin seed's existence probe at layer
		// build (role present → no-op).
		const env = Layer.mergeAll(
			Layer.succeed(Db, fakeDb({ selects: [[{ id: 1 }], [role], [], []] })),
			Layer.succeed(PlatformAdmin, adminGate),
		);
		const rt = ManagedRuntime.make(
			servicesLayer().pipe(Layer.provide(env)) as unknown as Layer.Layer<unknown, never, never>,
		);
		try {
			const data = await rt.runPromise(
				Effect.scoped(loader()).pipe(
					Effect.provideService(Principal, {
						userId: ADMIN.userId,
						email: ADMIN.email,
					}),
				),
			);
			expect(data.roles).toHaveLength(1);
			expect(data.details).toEqual([]);
			expect(data.assignments).toEqual([]);
		} finally {
			await rt.dispose();
		}
	});
});

describe("plugins", () => {
	it("declares tables, services and panel as single-concern plugins", () => {
		expect(rbacTablesPlugin.id).toBe("rbac.tables");
		expect(rbacTablesPlugin.tables).toBeDefined();
		expect(Object.keys(rbacTablesPlugin.tables ?? {})).toEqual([
			"roles",
			"rolePermissions",
			"subjectRoles",
			"relationTuples",
			"permissionEpoch",
		]);
		expect(rbacServicesPlugin.id).toBe("rbac.services");
		expect(rbacServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
		expect(rbacServicesPlugin.services).toBeDefined();
		expect(rbacPanelPlugin.id).toBe("rbac.panel");
		expect(rbacPanelPlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(rbacPanelPlugin.panel?.pages?.[0]).toMatchObject({
			id: "rbac.admin",
			path: "/platform/roles",
		});
		expect(rbacChromePlugin.id).toBe("rbac.chrome");
		expect(rbacChromePlugin.chrome).toEqual([
			{
				id: "rbac.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: { to: "/platform/roles", label: "Roles", icon: ShieldCheckIcon, group: "Identity" },
				},
			},
		]);
		expect(plugins).toEqual([
			rbacTablesPlugin,
			rbacServicesPlugin,
			rbacChromePlugin,
			rbacPanelPlugin,
		]);
	});
});
