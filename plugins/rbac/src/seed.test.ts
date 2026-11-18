import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { AUDIT_TEST_DDL, adminAudit } from "@ktb/audit";
import { makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import {
	buildPermissions,
	PERMISSION_CATALOG,
	readEpoch,
	rolePermissions,
	roles,
	subjectRoles,
	splitPermission,
} from "@ktb/rbac";

import { ensureSuperadminRole, SUPERADMIN_ROLE_NAME } from "./seed.ts";

const DDL = `
CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE role_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, resource TEXT NOT NULL, action TEXT NOT NULL, effect TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX role_permissions_role_resource_action_idx ON role_permissions (role_id, resource, action);
CREATE TABLE subject_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, tenant_id TEXT, granted_by TEXT, expires_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
${AUDIT_TEST_DDL}
`;

const freshDb = () => makeDb(makeD1(DDL));

describe("ensureSuperadminRole", () => {
	it("creates the role with an allow grant for every catalog permission", async () => {
		const db = freshDb();
		expect(await ensureSuperadminRole(db)).toBe("created");

		const roleRows = await db.select().from(roles).where(eq(roles.name, SUPERADMIN_ROLE_NAME));
		expect(roleRows).toHaveLength(1);
		const roleId = roleRows[0]!.id;
		expect(JSON.parse(roleRows[0]!.meta!)).toEqual({ system: true });

		const grants = await db
			.select()
			.from(rolePermissions)
			.where(eq(rolePermissions.roleId, roleId));
		expect(grants).toHaveLength(PERMISSION_CATALOG.length);
		for (const grant of grants) expect(grant.effect).toBe("allow");
		// Every catalog key is covered exactly once, under its split
		// resource/action spelling.
		const covered = new Set(grants.map((g) => `${g.resource} ${g.action}`));
		const expected = new Set(
			PERMISSION_CATALOG.map((key) => {
				const { resource, action } = splitPermission(key);
				return `${resource} ${action}`;
			}),
		);
		expect(covered).toEqual(expected);
	});

	it("writes a system-actor audit row on creation", async () => {
		const db = freshDb();
		await ensureSuperadminRole(db);
		const rows = await db.select().from(adminAudit);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "rbac.role.seed",
			targetType: "role",
			actorUserId: null,
			actorEmail: null,
		});
		expect(JSON.parse(rows[0]!.detail!)).toMatchObject({
			system: true,
			grantCount: PERMISSION_CATALOG.length,
		});
	});

	it("bumps the permission epoch on creation", async () => {
		const db = freshDb();
		expect(await readEpoch(db)).toBe(0);
		await ensureSuperadminRole(db);
		expect(await readEpoch(db)).toBe(1);
	});

	it("is a no-op when the role already exists — revoked grants stay revoked", async () => {
		const db = freshDb();
		await ensureSuperadminRole(db);
		const role = (await db.select().from(roles).where(eq(roles.name, SUPERADMIN_ROLE_NAME)))[0]!;
		// Simulate an admin revoking one grant and re-running the seed.
		const [first] = await db
			.select()
			.from(rolePermissions)
			.where(eq(rolePermissions.roleId, role.id));
		await db.delete(rolePermissions).where(eq(rolePermissions.id, first!.id));
		const epochBefore = await readEpoch(db);

		expect(await ensureSuperadminRole(db)).toBe("exists");
		expect(await readEpoch(db)).toBe(epochBefore);
		const grants = await db
			.select()
			.from(rolePermissions)
			.where(eq(rolePermissions.roleId, role.id));
		expect(grants).toHaveLength(PERMISSION_CATALOG.length - 1);
	});

	it("reports 'custom' for a pre-existing hand-made role and leaves it untouched", async () => {
		const db = freshDb();
		await db.insert(roles).values({
			name: SUPERADMIN_ROLE_NAME,
			description: "custom",
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		expect(await ensureSuperadminRole(db)).toBe("custom");
		const grants = await db
			.select()
			.from(rolePermissions)
			.innerJoin(roles, eq(rolePermissions.roleId, roles.id))
			.where(eq(roles.name, SUPERADMIN_ROLE_NAME));
		expect(grants).toHaveLength(0);
	});

	it("the seeded role resolves platform.admin for an assigned user", async () => {
		const db = freshDb();
		await ensureSuperadminRole(db);
		const role = (await db.select().from(roles).where(eq(roles.name, SUPERADMIN_ROLE_NAME)))[0]!;
		await db.insert(subjectRoles).values({
			subjectKind: "user",
			subjectId: "root",
			roleId: role.id,
			tenantId: null,
			grantedBy: null,
			expiresAt: null,
			createdAt: new Date(),
		});
		const permissions = buildPermissions(db);
		const can = (userId: string, resource: string, action: string) =>
			Effect.runPromise(permissions.canFor(userId, resource, action));
		await expect(can("root", "platform", "admin")).resolves.toBe(true);
		await expect(can("root", "patient", "read")).resolves.toBe(true);
		await expect(can("other", "platform", "admin")).resolves.toBe(false);
	});
});
