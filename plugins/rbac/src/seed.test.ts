import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { adminAudit } from "@ktb/audit";
import { makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { relationTuples } from "@ktb/db/schema";
import { buildPermissions, readEpoch, roles, splitPermission } from "@ktb/rbac";

import { PERMISSION_CATALOG } from "./catalog.ts";
import { ensureSuperadminRole, SUPERADMIN_ROLE_NAME } from "./seed.ts";

const freshDb = () => makeDb(makeTestD1());

describe("ensureSuperadminRole", () => {
	it("creates the role with an allow grant tuple for every catalog permission", async () => {
		const db = freshDb();
		expect(await ensureSuperadminRole(db)).toBe("created");

		const roleRows = await db.select().from(roles).where(eq(roles.name, SUPERADMIN_ROLE_NAME));
		expect(roleRows).toHaveLength(1);
		expect(JSON.parse(roleRows[0]!.meta!)).toEqual({ system: true });

		// Grants are relation tuples keyed on the role NAME with the
		// "*" object wildcard — the only grant store.
		const tuples = await db
			.select()
			.from(relationTuples)
			.where(eq(relationTuples.subjectId, SUPERADMIN_ROLE_NAME));
		expect(tuples).toHaveLength(PERMISSION_CATALOG.length);
		for (const tuple of tuples) {
			expect(tuple).toMatchObject({
				objectId: "*",
				subjectKind: "role",
				effect: "allow",
				tenantId: null,
			});
		}
		// Every catalog key is covered exactly once, under its split
		// resource/action spelling.
		const covered = new Set(tuples.map((t) => `${t.objectType} ${t.relation}`));
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
		// Simulate an admin revoking one grant and re-running the seed.
		const [first] = await db
			.select()
			.from(relationTuples)
			.where(eq(relationTuples.subjectId, SUPERADMIN_ROLE_NAME));
		await db.delete(relationTuples).where(eq(relationTuples.id, first!.id));
		const epochBefore = await readEpoch(db);

		expect(await ensureSuperadminRole(db)).toBe("exists");
		expect(await readEpoch(db)).toBe(epochBefore);
		const tuples = await db
			.select()
			.from(relationTuples)
			.where(eq(relationTuples.subjectId, SUPERADMIN_ROLE_NAME));
		expect(tuples).toHaveLength(PERMISSION_CATALOG.length - 1);
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
		const tuples = await db
			.select()
			.from(relationTuples)
			.where(eq(relationTuples.subjectId, SUPERADMIN_ROLE_NAME));
		expect(tuples).toHaveLength(0);
	});

	it("the seeded role resolves platform.admin for an assigned user", async () => {
		const db = freshDb();
		await ensureSuperadminRole(db);
		// Resolution reads relation_tuples: the member tuple
		// assignSubject would have written for this assignment.
		await db.insert(relationTuples).values({
			objectType: "role",
			objectId: SUPERADMIN_ROLE_NAME,
			relation: "member",
			subjectKind: "user",
			subjectId: "root",
			effect: "allow",
			tenantId: null,
			expiresAt: null,
			grantedBy: null,
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
