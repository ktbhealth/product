import { beforeAll, describe, expect, it, vi } from "vitest";

import { Forbidden, Principal } from "@ktb/authz";
import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { eq } from "drizzle-orm";

import {
	buildPermissions,
	bumpEpoch,
	deleteRelationTuples,
	entityAuthz,
	grantKey,
	GroupMembership,
	isKnownPermission,
	permissionKey,
	PermissionInvalidator,
	Permissions,
	PermissionsLive,
	permissionsService,
	readEpoch,
	requireEntityAccess,
	splitPermission,
	subjectRoles,
	writeRelationTuple,
} from "./index.ts";
import { relationTuples, rolePermissions, roles } from "@ktb/db/schema";

const DDL = `
CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE role_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, resource TEXT NOT NULL, action TEXT NOT NULL, effect TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX role_permissions_role_resource_action_idx ON role_permissions (role_id, resource, action);
CREATE TABLE subject_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, tenant_id TEXT, granted_by TEXT, expires_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX subject_roles_subject_idx ON subject_roles (subject_kind, subject_id);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
CREATE INDEX relation_tuples_object_idx ON relation_tuples (object_type, object_id, relation);
CREATE INDEX relation_tuples_subject_idx ON relation_tuples (subject_kind, subject_id);
CREATE INDEX relation_tuples_natural_idx ON relation_tuples (object_type, object_id, relation, subject_kind, subject_id);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
`;

/**
 * Test-local port of the P-101 migration backfill (0060): rebuild
 * `relation_tuples` from the admin-facing role_permissions /
 * subject_roles tables so resolution — which reads tuples — sees the
 * same grants the seeds wrote. Delete-then-insert keeps it idempotent
 * across the incremental mutations tests perform mid-suite.
 */
const mirrorTuples = async (db: DbClient) => {
	const roleRows = await db.select({ id: roles.id, name: roles.name }).from(roles);
	const nameById = new Map(roleRows.map((r) => [r.id, r.name]));
	const grantRows = await db.select().from(rolePermissions);
	const memberRows = await db.select().from(subjectRoles);
	const tuples = [
		...grantRows.flatMap((g) => {
			const roleName = nameById.get(g.roleId);
			return roleName === undefined
				? []
				: [
						{
							objectType: g.resource,
							objectId: "*",
							relation: g.action,
							subjectKind: "role",
							subjectId: roleName,
							effect: g.effect,
							tenantId: null,
							expiresAt: null,
							grantedBy: null,
							createdAt: g.createdAt,
						},
					];
		}),
		...memberRows.flatMap((m) => {
			const roleName = nameById.get(m.roleId);
			return roleName === undefined
				? []
				: [
						{
							objectType: "role",
							objectId: roleName,
							relation: "member",
							subjectKind: m.subjectKind,
							subjectId: m.subjectId,
							effect: "allow",
							tenantId: m.tenantId,
							expiresAt: m.expiresAt,
							grantedBy: m.grantedBy,
							createdAt: m.createdAt,
						},
					];
		}),
	];
	await db.delete(relationTuples);
	if (tuples.length > 0) await db.insert(relationTuples).values(tuples);
};

const seed = async (db: DbClient) => {
	await db.insert(roles).values([
		{
			id: 1,
			name: "auditor",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		{
			id: 2,
			name: "billing",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		{
			id: 3,
			name: "temp",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
	]);
	await db.insert(rolePermissions).values([
		{ roleId: 1, resource: "patient", action: "read", effect: "allow", createdAt: new Date(0) },
		{ roleId: 1, resource: "patient", action: "delete", effect: "deny", createdAt: new Date(0) },
		{ roleId: 2, resource: "billing", action: "manage", effect: "allow", createdAt: new Date(0) },
		{
			roleId: 3,
			resource: "consultation",
			action: "read",
			effect: "allow",
			createdAt: new Date(0),
		},
	]);
	await db.insert(subjectRoles).values([
		// u1: auditor globally + billing inside tenant t1
		{
			subjectKind: "user",
			subjectId: "u1",
			roleId: 1,
			tenantId: null,
			grantedBy: "admin",
			createdAt: new Date(0),
		},
		{
			subjectKind: "user",
			subjectId: "u1",
			roleId: 2,
			tenantId: "t1",
			grantedBy: "admin",
			createdAt: new Date(0),
		},
		// g9: auditor globally
		{
			subjectKind: "group",
			subjectId: "9",
			roleId: 1,
			tenantId: null,
			grantedBy: "admin",
			createdAt: new Date(0),
		},
		// u2: temp role, already expired
		{
			subjectKind: "user",
			subjectId: "u2",
			roleId: 3,
			tenantId: null,
			grantedBy: "admin",
			expiresAt: new Date(Date.now() - 1000),
			createdAt: new Date(0),
		},
		// u3: temp role expiring in the future
		{
			subjectKind: "user",
			subjectId: "u3",
			roleId: 3,
			tenantId: null,
			grantedBy: "admin",
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(0),
		},
	]);
	await mirrorTuples(db);
};

describe("permission epoch", () => {
	it("readEpoch returns 0 before any bump, bumpEpoch increments", async () => {
		const db = makeDb(makeD1(DDL));
		expect(await readEpoch(db)).toBe(0);
		await bumpEpoch(db);
		expect(await readEpoch(db)).toBe(1);
		await bumpEpoch(db);
		expect(await readEpoch(db)).toBe(2);
	});
});

describe("buildPermissions", () => {
	let db: DbClient;
	let permissions: ReturnType<typeof buildPermissions>;

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		await seed(db);
		permissions = buildPermissions(db, (userId) =>
			Effect.succeed<readonly string[]>(userId === "u4" ? ["9"] : []),
		);
	});

	it("resolves direct user grants minus tenant-scoped ones", async () => {
		const grants = await Effect.runPromise(permissions.permissionsFor("u1"));
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
		expect(grants.get(grantKey("patient", "delete"))).toBe("deny");
		// tenant-scoped grant invisible without a tenant
		expect(grants.has(grantKey("billing", "manage"))).toBe(false);
	});

	it("includes tenant-scoped grants when the tenant matches", async () => {
		const grants = await Effect.runPromise(permissions.permissionsFor("u1", "t1"));
		expect(grants.get(grantKey("billing", "manage"))).toBe("allow");
		// a different tenant sees only global grants
		const other = await Effect.runPromise(permissions.permissionsFor("u1", "t2"));
		expect(other.has(grantKey("billing", "manage"))).toBe(false);
	});

	it("resolves group-derived grants through the port", async () => {
		// u4 has no direct roles but belongs to group 9 (auditor).
		const grants = await Effect.runPromise(permissions.permissionsFor("u4"));
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
		expect(grants.get(grantKey("patient", "delete"))).toBe("deny");
	});

	it("honours expires_at at resolve time", async () => {
		const expired = await Effect.runPromise(permissions.permissionsFor("u2"));
		expect(expired.size).toBe(0);
		const live = await Effect.runPromise(permissions.permissionsFor("u3"));
		expect(live.get(grantKey("consultation", "read"))).toBe("allow");
	});

	it("canFor/can/requirePermission* enforce grants and deny", async () => {
		expect(await Effect.runPromise(permissions.canFor("u1", "patient", "read"))).toBe(true);
		expect(await Effect.runPromise(permissions.canFor("u1", "billing", "manage", "t1"))).toBe(true);
		// deny grant: the key exists in permissionsFor but canFor is false.
		expect(await Effect.runPromise(permissions.canFor("u1", "patient", "delete"))).toBe(false);
		await Effect.runPromise(permissions.requirePermissionFor("u1", "patient", "read"));
		const denied = await Effect.runPromise(
			permissions.requirePermissionFor("u1", "patient", "update").pipe(Effect.flip),
		);
		expect(denied).toBeInstanceOf(Forbidden);
		expect(denied.path).toBe("rbac.patient.update");
	});

	it("can/requirePermission bind to the Principal and fail closed", async () => {
		const program = Effect.gen(function* () {
			const p = yield* Permissions;
			expect(yield* p.can("patient", "read")).toBe(true);
			expect(yield* p.can("billing", "manage", { tenantId: "t1" })).toBe(true);
			yield* p.requirePermission("patient", "read");
			return yield* p.requirePermission("patient", "delete").pipe(Effect.flip);
		});
		const DbLive = Layer.succeed(Db, db);
		const runtime = ManagedRuntime.make(
			Layer.merge(DbLive, PermissionsLive.pipe(Layer.provide(DbLive))),
		);
		const result = await runtime.runPromise(
			program.pipe(Effect.provideService(Principal, { userId: "u1" })),
		);
		expect(result).toBeInstanceOf(Forbidden);

		// No principal → can false, requirePermission Forbidden.
		const anon = await runtime.runPromise(
			Effect.gen(function* () {
				const p = yield* Permissions;
				return {
					can: yield* p.can("patient", "read"),
					err: yield* Effect.flip(p.requirePermission("patient", "read")),
				};
			}),
		);
		expect(anon.can).toBe(false);
		expect(anon.err).toBeInstanceOf(Forbidden);
		expect(anon.err.path).toBe("rbac.patient.read");
		await runtime.dispose();
	});

	it("caches per (user, tenant, epoch) and invalidate() refreshes", async () => {
		const p = buildPermissions(db);
		const before = await Effect.runPromise(p.permissionsFor("u9"));
		expect(before.size).toBe(0);
		// grant u9 the auditor role directly, then invalidate
		await db.insert(subjectRoles).values({
			subjectKind: "user",
			subjectId: "u9",
			roleId: 1,
			tenantId: null,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		await mirrorTuples(db);
		await Effect.runPromise(p.invalidate());
		const after = await Effect.runPromise(p.permissionsFor("u9"));
		expect(after.get(grantKey("patient", "read"))).toBe("allow");
	});

	it("expires_at passes between resolves via notAfter", async () => {
		const p = buildPermissions(db);
		const first = await Effect.runPromise(p.permissionsFor("u3"));
		expect(first.has(grantKey("consultation", "read"))).toBe(true);
		const second = await Effect.runPromise(p.permissionsFor("u3"));
		expect(second).toBe(first);
	});

	it("skips a duplicate allow grant for the same (resource, action)", async () => {
		// u5 holds two roles that both allow patient.read — the second
		// row must not overwrite the first (deny-wins ordering stays
		// stable regardless of row order).
		await db.insert(roles).values({
			id: 4,
			name: "auditor2",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		await db.insert(rolePermissions).values({
			roleId: 4,
			resource: "patient",
			action: "read",
			effect: "allow",
			createdAt: new Date(0),
		});
		await db.insert(subjectRoles).values([
			{
				subjectKind: "user",
				subjectId: "u5",
				roleId: 1,
				tenantId: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
			{
				subjectKind: "user",
				subjectId: "u5",
				roleId: 4,
				tenantId: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
		]);
		await mirrorTuples(db);
		const p = buildPermissions(db);
		const grants = await Effect.runPromise(p.permissionsFor("u5"));
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
		expect(grants.get(grantKey("patient", "delete"))).toBe("deny");
	});

	it("tracks the earliest expiry across multiple grants", async () => {
		// u6: two expiring assignments — the second row's expiry is later
		// than the first's, exercising the notAfter comparison both ways.
		await db.insert(subjectRoles).values([
			{
				subjectKind: "user",
				subjectId: "u6",
				roleId: 1,
				tenantId: null,
				grantedBy: "test",
				expiresAt: new Date(Date.now() + 30_000),
				createdAt: new Date(0),
			},
			{
				subjectKind: "user",
				subjectId: "u6",
				roleId: 3,
				tenantId: null,
				grantedBy: "test",
				expiresAt: new Date(Date.now() + 90_000),
				createdAt: new Date(0),
			},
		]);
		await mirrorTuples(db);
		const p = buildPermissions(db);
		const grants = await Effect.runPromise(p.permissionsFor("u6"));
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
		expect(grants.get(grantKey("consultation", "read"))).toBe("allow");
	});

	it("clears the grant cache once it reaches the bound", async () => {
		const p = buildPermissions(db);
		// CACHE_LIMIT is 1000 — resolving one more distinct user evicts
		// the whole map; earlier entries must re-resolve cleanly.
		for (let i = 0; i < 1001; i++) {
			await Effect.runPromise(p.permissionsFor(`bulk-${i}`));
		}
		const grants = await Effect.runPromise(p.permissionsFor("u1"));
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
	});

	it("returns the same grant set object on a warm cache hit", async () => {
		const p = buildPermissions(db);
		const first = await Effect.runPromise(p.permissionsFor("u1"));
		const second = await Effect.runPromise(p.permissionsFor("u1"));
		expect(second).toBe(first);
	});

	it("keeps warm entries across misses below the cache bound", async () => {
		const p = buildPermissions(db);
		const first = await Effect.runPromise(p.permissionsFor("u1"));
		// A distinct user misses and re-caches without evicting u1.
		await Effect.runPromise(p.permissionsFor("u21"));
		const second = await Effect.runPromise(p.permissionsFor("u1"));
		expect(second).toBe(first);
	});

	it("re-resolves when the epoch bumps without invalidate()", async () => {
		// External writers bump the epoch directly; the cache must notice
		// even though cache.clear() never ran.
		const p = buildPermissions(db);
		const before = await Effect.runPromise(p.permissionsFor("u25"));
		expect(before.size).toBe(0);
		await db.insert(subjectRoles).values({
			subjectKind: "user",
			subjectId: "u25",
			roleId: 1,
			tenantId: null,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		await mirrorTuples(db);
		await bumpEpoch(db);
		const after = await Effect.runPromise(p.permissionsFor("u25"));
		expect(after.get(grantKey("patient", "read"))).toBe("allow");
	});

	it("re-resolves grants as expires_at boundaries pass", async () => {
		const t0 = Date.now();
		await db.insert(roles).values({
			id: 6,
			name: "auditor3",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		await db.insert(rolePermissions).values({
			roleId: 6,
			resource: "audit",
			action: "read",
			effect: "allow",
			createdAt: new Date(0),
		});
		await db.insert(subjectRoles).values([
			// Expiries arrive +20s, +10s, +20s: the earliest is neither the
			// first nor the last row, so first-wins/last-wins mutants on
			// the notAfter tracking both pick the wrong boundary.
			{
				subjectKind: "user",
				subjectId: "u15",
				roleId: 3,
				tenantId: null,
				grantedBy: "test",
				expiresAt: new Date(t0 + 20_000),
				createdAt: new Date(t0),
			},
			{
				subjectKind: "user",
				subjectId: "u15",
				roleId: 1,
				tenantId: null,
				grantedBy: "test",
				expiresAt: new Date(t0 + 10_000),
				createdAt: new Date(t0),
			},
			{
				subjectKind: "user",
				subjectId: "u15",
				roleId: 6,
				tenantId: null,
				grantedBy: "test",
				expiresAt: new Date(t0 + 20_000),
				createdAt: new Date(t0),
			},
			{
				subjectKind: "user",
				subjectId: "u15",
				roleId: 2,
				tenantId: null,
				grantedBy: "test",
				createdAt: new Date(t0),
			},
		]);
		await mirrorTuples(db);
		const p = buildPermissions(db);
		const now = vi.spyOn(Date, "now").mockReturnValue(t0);
		try {
			const first = await Effect.runPromise(p.permissionsFor("u15"));
			expect(first.get(grantKey("patient", "read"))).toBe("allow");
			expect(first.get(grantKey("consultation", "read"))).toBe("allow");
			expect(first.get(grantKey("audit", "read"))).toBe("allow");
			expect(first.get(grantKey("billing", "manage"))).toBe("allow");
			// Exactly at the earliest expiry: that grant is gone (expires_at
			// is strict), the later and unexpired grants remain.
			now.mockReturnValue(t0 + 10_000);
			const second = await Effect.runPromise(p.permissionsFor("u15"));
			expect(second.has(grantKey("patient", "read"))).toBe(false);
			expect(second.get(grantKey("consultation", "read"))).toBe("allow");
			expect(second.get(grantKey("audit", "read"))).toBe("allow");
			expect(second.get(grantKey("billing", "manage"))).toBe("allow");
		} finally {
			now.mockRestore();
		}
	});

	it("keeps tenant-less and tenant-scoped cache keys distinct", async () => {
		await db.insert(subjectRoles).values({
			subjectKind: "user",
			subjectId: "u22",
			roleId: 2,
			tenantId: "Stryker was here!",
			grantedBy: "test",
			createdAt: new Date(0),
		});
		await mirrorTuples(db);
		const p = buildPermissions(db);
		// The tenant-less resolve caches first; a cache key that reused the
		// empty-tenant fallback for this tenant id would collide with it.
		const global = await Effect.runPromise(p.permissionsFor("u22"));
		expect(global.has(grantKey("billing", "manage"))).toBe(false);
		const scoped = await Effect.runPromise(p.permissionsFor("u22", "Stryker was here!"));
		expect(scoped.get(grantKey("billing", "manage"))).toBe("allow");
	});

	it("does not treat the string 'undefined' as the absent-tenant marker", async () => {
		await db.insert(subjectRoles).values({
			subjectKind: "user",
			subjectId: "u23",
			roleId: 2,
			tenantId: "undefined",
			grantedBy: "test",
			createdAt: new Date(0),
		});
		await mirrorTuples(db);
		const p = buildPermissions(db);
		const grants = await Effect.runPromise(p.permissionsFor("u23"));
		expect(grants.has(grantKey("billing", "manage"))).toBe(false);
	});

	it("does not invent group memberships when the port is absent", async () => {
		// A group literally named like the mutant's placeholder must not
		// leak into resolves for users with no membership port wired.
		await db.insert(subjectRoles).values({
			subjectKind: "group",
			subjectId: "Stryker was here",
			roleId: 1,
			tenantId: null,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		await mirrorTuples(db);
		const p = buildPermissions(db);
		const grants = await Effect.runPromise(p.permissionsFor("u24"));
		expect(grants.has(grantKey("patient", "read"))).toBe(false);
	});

	it("deny wins regardless of the order grant rows arrive", async () => {
		await db.insert(roles).values({
			id: 5,
			name: "auditor-deny",
			description: null,
			meta: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		await db.insert(rolePermissions).values({
			roleId: 5,
			resource: "patient",
			action: "read",
			effect: "deny",
			createdAt: new Date(0),
		});
		await db.insert(subjectRoles).values([
			// u17: deny assignment first, allow second — a last-write-wins
			// mutant would let the allow overwrite the deny.
			{
				subjectKind: "user",
				subjectId: "u17",
				roleId: 5,
				tenantId: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
			{
				subjectKind: "user",
				subjectId: "u17",
				roleId: 1,
				tenantId: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
			// u18: allow first, deny second — a first-write-wins mutant
			// keeps the allow.
			{
				subjectKind: "user",
				subjectId: "u18",
				roleId: 1,
				tenantId: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
			{
				subjectKind: "user",
				subjectId: "u18",
				roleId: 5,
				tenantId: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
		]);
		await mirrorTuples(db);
		const p = buildPermissions(db);
		for (const userId of ["u17", "u18"]) {
			expect(await Effect.runPromise(p.canFor(userId, "patient", "read"))).toBe(false);
			const grants = await Effect.runPromise(p.permissionsFor(userId));
			expect(grants.get(grantKey("patient", "read"))).toBe("deny");
		}
	});

	it("resolves direct user grant tuples (P-101 forward-compat)", async () => {
		// No role involved: a grant tuple addressed straight at the user.
		await db.insert(relationTuples).values({
			objectType: "billing",
			objectId: "*",
			relation: "manage",
			subjectKind: "user",
			subjectId: "u30",
			effect: "allow",
			tenantId: null,
			expiresAt: null,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		const p = buildPermissions(db);
		const grants = await Effect.runPromise(p.permissionsFor("u30"));
		expect(grants.get(grantKey("billing", "manage"))).toBe("allow");
	});

	it("resolves direct group grant tuples through the port", async () => {
		await db.insert(relationTuples).values({
			objectType: "audit",
			objectId: "*",
			relation: "read",
			subjectKind: "group",
			subjectId: "gd1",
			effect: "allow",
			tenantId: null,
			expiresAt: null,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		const p = buildPermissions(db, (userId) =>
			Effect.succeed<readonly string[]>(userId === "u31" ? ["gd1"] : []),
		);
		expect(await Effect.runPromise(p.canFor("u31", "audit", "read"))).toBe(true);
		// u32 is not in gd1 — the group grant must not leak.
		expect(await Effect.runPromise(p.canFor("u32", "audit", "read"))).toBe(false);
	});

	it("deny via a role grant beats allow via a direct grant", async () => {
		await db.insert(relationTuples).values([
			// u33 is a member of auditor (which denies patient.delete)…
			{
				objectType: "role",
				objectId: "auditor",
				relation: "member",
				subjectKind: "user",
				subjectId: "u33",
				effect: "allow",
				tenantId: null,
				expiresAt: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
			// …and also holds a direct allow on the same (resource, action).
			{
				objectType: "patient",
				objectId: "*",
				relation: "delete",
				subjectKind: "user",
				subjectId: "u33",
				effect: "allow",
				tenantId: null,
				expiresAt: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
		]);
		const p = buildPermissions(db);
		const grants = await Effect.runPromise(p.permissionsFor("u33"));
		expect(grants.get(grantKey("patient", "delete"))).toBe("deny");
		expect(await Effect.runPromise(p.canFor("u33", "patient", "delete"))).toBe(false);
		// The role's allow on patient.read still applies alongside.
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
	});

	it("scopes member tuples by tenant like subject_roles did", async () => {
		await db.insert(relationTuples).values({
			objectType: "role",
			objectId: "billing",
			relation: "member",
			subjectKind: "user",
			subjectId: "u34",
			effect: "allow",
			tenantId: "t9",
			expiresAt: null,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		const p = buildPermissions(db);
		// No tenant context and a different tenant both see nothing.
		expect(
			(await Effect.runPromise(p.permissionsFor("u34"))).has(grantKey("billing", "manage")),
		).toBe(false);
		expect(
			(await Effect.runPromise(p.permissionsFor("u34", "tX"))).has(grantKey("billing", "manage")),
		).toBe(false);
		// The matching tenant resolves the role's global grant tuple.
		expect(
			(await Effect.runPromise(p.permissionsFor("u34", "t9"))).get(grantKey("billing", "manage")),
		).toBe("allow");
	});

	it("excludes expired member tuples at resolve time", async () => {
		await db.insert(relationTuples).values({
			objectType: "role",
			objectId: "auditor",
			relation: "member",
			subjectKind: "user",
			subjectId: "u35",
			effect: "allow",
			tenantId: null,
			expiresAt: new Date(Date.now() - 1000),
			grantedBy: "test",
			createdAt: new Date(0),
		});
		const p = buildPermissions(db);
		expect((await Effect.runPromise(p.permissionsFor("u35"))).size).toBe(0);
	});

	it("resolves role grants derived through group membership tuples", async () => {
		// g7 holds a member tuple to auditor; u36 reaches it only via
		// the GroupMembership port — no tuples name u36 directly.
		await db.insert(relationTuples).values({
			objectType: "role",
			objectId: "auditor",
			relation: "member",
			subjectKind: "group",
			subjectId: "g7",
			effect: "allow",
			tenantId: null,
			expiresAt: null,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		const p = buildPermissions(db, (userId) =>
			Effect.succeed<readonly string[]>(userId === "u36" ? ["g7"] : []),
		);
		const grants = await Effect.runPromise(p.permissionsFor("u36"));
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
		expect(grants.get(grantKey("patient", "delete"))).toBe("deny");
	});

	it("takes the earliest of member and grant expires_at", async () => {
		const soon = new Date(Date.now() + 10_000);
		const later = new Date(Date.now() + 20_000);
		const member = (roleName: string, subjectId: string, expiresAt: Date) => ({
			objectType: "role",
			objectId: roleName,
			relation: "member",
			subjectKind: "user",
			subjectId,
			effect: "allow",
			tenantId: null,
			expiresAt,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		const grant = (objectType: string, action: string, expiresAt: Date) => ({
			objectType,
			objectId: "*",
			relation: action,
			subjectKind: "role",
			subjectId: "temp",
			effect: "allow",
			tenantId: null,
			expiresAt,
			grantedBy: "test",
			createdAt: new Date(0),
		});
		await db.insert(relationTuples).values([
			// temp member outlives its grant tuple → grant expiry wins.
			member("temp", "u40", later),
			grant("consultation", "read", soon),
			// billing member expires first → member expiry wins.
			{ ...member("billing", "u40", soon), subjectKind: "user" },
			{ ...grant("billing", "manage", later), subjectId: "billing" },
		]);
		const p = buildPermissions(db);
		expect(await Effect.runPromise(p.canFor("u40", "consultation", "read"))).toBe(true);
		expect(await Effect.runPromise(p.canFor("u40", "billing", "manage"))).toBe(true);
	});

	it("merges duplicate role memberships from user and group subjects", async () => {
		await db.insert(relationTuples).values([
			{
				objectType: "role",
				objectId: "auditor",
				relation: "member",
				subjectKind: "user",
				subjectId: "u41",
				effect: "allow",
				tenantId: null,
				expiresAt: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
			{
				objectType: "role",
				objectId: "auditor",
				relation: "member",
				subjectKind: "group",
				subjectId: "g8",
				effect: "allow",
				tenantId: null,
				expiresAt: null,
				grantedBy: "test",
				createdAt: new Date(0),
			},
		]);
		const p = buildPermissions(db, (userId) =>
			Effect.succeed<readonly string[]>(userId === "u41" ? ["g8"] : []),
		);
		const grants = await Effect.runPromise(p.permissionsFor("u41"));
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
		expect(grants.get(grantKey("patient", "delete"))).toBe("deny");
	});
});

describe("permissionsService", () => {
	it("builds without GroupMembership (no group grants)", async () => {
		const db = makeDb(makeD1(DDL));
		await seed(db);
		const DbLive = Layer.succeed(Db, db);
		const runtime = ManagedRuntime.make(
			Layer.merge(DbLive, PermissionsLive.pipe(Layer.provide(DbLive))),
		);
		const grants = await runtime.runPromise(
			Effect.gen(function* () {
				const p = yield* Permissions;
				return yield* p.permissionsFor("u1");
			}),
		);
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
		await runtime.dispose();
	});

	it("wires GroupMembership when provided", async () => {
		const db = makeDb(makeD1(DDL));
		await seed(db);
		const membership = GroupMembership.of({
			groupIdsFor: () => Effect.succeed<readonly string[]>(["9"]),
		});
		const DbLive = Layer.succeed(Db, db);
		const runtime = ManagedRuntime.make(
			Layer.merge(
				Layer.mergeAll(DbLive, Layer.succeed(GroupMembership, membership)),
				PermissionsLive.pipe(
					Layer.provide(Layer.mergeAll(DbLive, Layer.succeed(GroupMembership, membership))),
				),
			),
		);
		const grants = await runtime.runPromise(
			Effect.gen(function* () {
				const p = yield* Permissions;
				return yield* p.permissionsFor("u4");
			}),
		);
		expect(grants.get(grantKey("patient", "read"))).toBe("allow");
		await runtime.dispose();
	});

	it("permissionsService effect resolves the same shape", async () => {
		const db = makeDb(makeD1(DDL));
		await seed(db);
		const shape = await Effect.runPromise(permissionsService.pipe(Effect.provideService(Db, db)));
		const grants = await Effect.runPromise(shape.permissionsFor("u1", "t1"));
		expect(grants.get(grantKey("billing", "manage"))).toBe("allow");
	});
});

describe("entity authz seam", () => {
	let db: DbClient;

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		await seed(db);
	});

	it("rbac mode checks dynamic grants through Permissions", async () => {
		const DbLive = Layer.succeed(Db, db);
		const runtime = ManagedRuntime.make(
			Layer.merge(DbLive, PermissionsLive.pipe(Layer.provide(DbLive))),
		);
		const result = await runtime.runPromise(
			Effect.gen(function* () {
				yield* requireEntityAccess(entityAuthz("rbac", "patient", "read"));
				return yield* Effect.flip(requireEntityAccess(entityAuthz("rbac", "patient", "update")));
			}).pipe(Effect.provideService(Principal, { userId: "u1" })),
		);
		expect(result).toBeInstanceOf(Forbidden);
		await runtime.dispose();
	});

	it("rbac mode forwards the entity tenantId to Permissions", async () => {
		const DbLive = Layer.succeed(Db, db);
		const runtime = ManagedRuntime.make(
			Layer.merge(DbLive, PermissionsLive.pipe(Layer.provide(DbLive))),
		);
		const result = await runtime.runPromise(
			Effect.gen(function* () {
				// billing.manage is granted to u1 inside tenant t1 only.
				yield* requireEntityAccess(entityAuthz("rbac", "billing", "manage", { tenantId: "t1" }));
				return yield* Effect.flip(
					requireEntityAccess(entityAuthz("rbac", "billing", "manage", { tenantId: "t2" })),
				);
			}).pipe(Effect.provideService(Principal, { userId: "u1" })),
		);
		expect(result).toBeInstanceOf(Forbidden);
		await runtime.dispose();
	});

	it("static mode delegates to permix rulesFor", async () => {
		// patient.read static rule: ownerId must equal principal userId.
		const ok = await Effect.runPromise(
			requireEntityAccess(entityAuthz("static", "patient", "read"), {
				ownerId: "u1",
			}).pipe(Effect.provideService(Principal, { userId: "u1" })),
		);
		expect(ok).toBeUndefined();
		const err = await Effect.runPromise(
			Effect.flip(
				requireEntityAccess(entityAuthz("static", "patient", "read"), {
					ownerId: "someone-else",
				}).pipe(Effect.provideService(Principal, { userId: "u1" })),
			),
		);
		expect(err).toBeInstanceOf(Forbidden);
	});
});

describe("vocabulary", () => {
	it("splits and rejoins permission strings", () => {
		expect(splitPermission("patient.read")).toEqual({ resource: "patient", action: "read" });
		expect(splitPermission("nodot")).toEqual({ resource: "nodot", action: "" });
		expect(permissionKey("patient", "read")).toBe("patient.read");
		expect(isKnownPermission("patient", "read")).toBe(true);
		expect(isKnownPermission("patient", "fly")).toBe(false);
		expect(isKnownPermission("billing", "manage")).toBe(true);
	});

	it("grantKey separates resource and action unambiguously", () => {
		expect(grantKey("patient", "read")).toBe("patient\u001fread");
		// Concatenation without a separator would collide these pairs.
		expect(grantKey("ab", "c")).not.toBe(grantKey("a", "bc"));
	});
});

describe("service identifiers", () => {
	it("exposes stable service keys", () => {
		expect(GroupMembership.key).toBe("@ktb/rbac/GroupMembership");
		expect(PermissionInvalidator.key).toBe("@ktb/rbac/PermissionInvalidator");
		expect(Permissions.key).toBe("@ktb/rbac/Permissions");
	});
});

describe("schema round-trip", () => {
	it("subject_roles rows round-trip through drizzle", async () => {
		const db = makeDb(makeD1(DDL));
		await seed(db);
		const rows = await db.select().from(subjectRoles).where(eq(subjectRoles.subjectId, "u1"));
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.roleId).sort((a, b) => a - b)).toEqual([1, 2]);
	});
});

describe("canObject / requireObject", () => {
	let db: DbClient;
	let permissions: ReturnType<typeof buildPermissions>;

	const tuple = (
		over: Partial<{
			objectType: string;
			objectId: string;
			relation: string;
			subjectKind: string;
			subjectId: string;
			effect: string;
			tenantId: string | null;
			expiresAt: Date | null;
			grantedBy: string | null;
		}>,
	) => ({
		objectType: "doc",
		objectId: "*",
		relation: "read",
		subjectKind: "user",
		subjectId: "u1",
		effect: "allow",
		tenantId: null,
		expiresAt: null,
		grantedBy: null,
		createdAt: new Date(0),
		...over,
	});

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
		await db.insert(relationTuples).values([
			// Direct user allow on a specific object.
			tuple({ objectType: "patient", objectId: "p1", relation: "read", subjectId: "u1" }),
			// Wildcard grant: every patient readable by u2.
			tuple({ objectType: "patient", objectId: "*", relation: "read", subjectId: "u2" }),
			// Deny beats allow for u3 on note n1.
			tuple({ objectType: "note", objectId: "n1", relation: "read", subjectId: "u3" }),
			tuple({
				objectType: "note",
				objectId: "n1",
				relation: "read",
				subjectId: "u3",
				effect: "deny",
			}),
			// Group subject: g9 readers via the port.
			tuple({
				objectType: "report",
				objectId: "r1",
				relation: "read",
				subjectKind: "group",
				subjectId: "g9",
			}),
			// Role subject: editor members write doc d9.
			tuple({
				objectType: "role",
				objectId: "editor",
				relation: "member",
				subjectKind: "user",
				subjectId: "u6",
			}),
			tuple({
				objectType: "doc",
				objectId: "d9",
				relation: "write",
				subjectKind: "role",
				subjectId: "editor",
			}),
			// Nested role→role: team ← squad ← u7.
			tuple({
				objectType: "role",
				objectId: "squad",
				relation: "member",
				subjectKind: "user",
				subjectId: "u7",
			}),
			tuple({
				objectType: "role",
				objectId: "team",
				relation: "member",
				subjectKind: "role",
				subjectId: "squad",
			}),
			tuple({
				objectType: "vault",
				objectId: "v1",
				relation: "open",
				subjectKind: "role",
				subjectId: "team",
			}),
			// Cycle: cycA ↔ cycB, with u9 reachable through the cycle.
			tuple({
				objectType: "role",
				objectId: "cycA",
				relation: "member",
				subjectKind: "role",
				subjectId: "cycB",
			}),
			tuple({
				objectType: "role",
				objectId: "cycB",
				relation: "member",
				subjectKind: "role",
				subjectId: "cycA",
			}),
			tuple({
				objectType: "role",
				objectId: "cycB",
				relation: "member",
				subjectKind: "user",
				subjectId: "u9",
			}),
			tuple({
				objectType: "lock",
				objectId: "l1",
				relation: "pick",
				subjectKind: "role",
				subjectId: "cycA",
			}),
			// Tenant-scoped tuple: only visible inside t1.
			tuple({
				objectType: "billing",
				objectId: "inv1",
				relation: "pay",
				subjectId: "u10",
				tenantId: "t1",
			}),
			// Expired tuple.
			tuple({
				objectType: "archive",
				objectId: "a1",
				relation: "read",
				subjectId: "u11",
				expiresAt: new Date(Date.now() - 1000),
			}),
			// Live tuple with a future expiry.
			tuple({
				objectType: "temp",
				objectId: "t1",
				relation: "use",
				subjectId: "u12",
				expiresAt: new Date(Date.now() + 60_000),
			}),
			// Corrupt effect counts as deny even alongside an allow.
			tuple({ objectType: "weird", objectId: "w1", relation: "x", subjectId: "u13" }),
			tuple({
				objectType: "weird",
				objectId: "w1",
				relation: "x",
				subjectId: "u13",
				effect: "bogus",
			}),
			// Unknown subject kind never reaches.
			tuple({
				objectType: "alien",
				objectId: "al1",
				relation: "read",
				subjectKind: "robot",
				subjectId: "u14",
			}),
			// Role chain deeper than the depth cap: deep0←deep1←deep2←
			// deep3←deep4←u22 — deep4 sits at depth 4 and is cut off.
			tuple({
				objectType: "deep",
				objectId: "d1",
				relation: "x",
				subjectKind: "role",
				subjectId: "deep0",
			}),
			tuple({
				objectType: "role",
				objectId: "deep0",
				relation: "member",
				subjectKind: "role",
				subjectId: "deep1",
			}),
			tuple({
				objectType: "role",
				objectId: "deep1",
				relation: "member",
				subjectKind: "role",
				subjectId: "deep2",
			}),
			tuple({
				objectType: "role",
				objectId: "deep2",
				relation: "member",
				subjectKind: "role",
				subjectId: "deep3",
			}),
			tuple({
				objectType: "role",
				objectId: "deep3",
				relation: "member",
				subjectKind: "role",
				subjectId: "deep4",
			}),
			tuple({
				objectType: "role",
				objectId: "deep4",
				relation: "member",
				subjectKind: "user",
				subjectId: "u22",
			}),
			// Expiring grant (+10s) over an expiring member (+20s): the
			// member expiry is later, exercising the notAfter min both ways.
			tuple({
				objectType: "note",
				objectId: "n3",
				relation: "read",
				subjectKind: "role",
				subjectId: "expRole",
				expiresAt: new Date(Date.now() + 10_000),
			}),
			tuple({
				objectType: "role",
				objectId: "expRole",
				relation: "member",
				subjectKind: "user",
				subjectId: "u21",
				expiresAt: new Date(Date.now() + 20_000),
			}),
		]);
		permissions = buildPermissions(db, (userId) =>
			Effect.succeed<readonly string[]>(userId === "u5" ? ["g9"] : []),
		);
	});

	const can = (
		userId: string,
		objectType: string,
		objectId: string,
		relation: string,
		tenantId?: string,
	) =>
		Effect.runPromise(
			permissions
				.canObject(objectType, objectId, relation, { tenantId })
				.pipe(Effect.provideService(Principal, { userId })),
		);

	it("allows a direct user tuple on the specific object only", async () => {
		expect(await can("u1", "patient", "p1", "read")).toBe(true);
		// Second identical check hits the object cache.
		expect(await can("u1", "patient", "p1", "read")).toBe(true);
		// The specific-object tuple does not leak to other ids.
		expect(await can("u1", "patient", "p2", "read")).toBe(false);
		// u4 holds no patient tuples at all.
		expect(await can("u4", "patient", "p1", "read")).toBe(false);
	});

	it("wildcard object_id tuples apply to every object of the type", async () => {
		expect(await can("u2", "patient", "p9", "read")).toBe(true);
		expect(await can("u2", "patient", "anything", "read")).toBe(true);
		// …but only for the granted relation.
		expect(await can("u2", "patient", "p9", "write")).toBe(false);
	});

	it("deny wins over allow for the same (object, relation)", async () => {
		expect(await can("u3", "note", "n1", "read")).toBe(false);
	});

	it("resolves group subjects through the GroupMembership port", async () => {
		expect(await can("u5", "report", "r1", "read")).toBe(true);
		// u6 is not in g9.
		expect(await can("u6", "report", "r1", "read")).toBe(false);
	});

	it("expands role subjects through member tuples", async () => {
		expect(await can("u6", "doc", "d9", "write")).toBe(true);
		expect(await can("u7", "doc", "d9", "write")).toBe(false);
	});

	it("expands nested role→role member chains", async () => {
		expect(await can("u7", "vault", "v1", "open")).toBe(true);
	});

	it("terminates on member-tuple cycles", async () => {
		expect(await can("u9", "lock", "l1", "pick")).toBe(true);
		expect(await can("u10x", "lock", "l1", "pick")).toBe(false);
	});

	it("scopes tuples by tenant like grant resolution", async () => {
		expect(await can("u10", "billing", "inv1", "pay", "t1")).toBe(true);
		expect(await can("u10", "billing", "inv1", "pay")).toBe(false);
		expect(await can("u10", "billing", "inv1", "pay", "t2")).toBe(false);
	});

	it("honours expires_at", async () => {
		expect(await can("u11", "archive", "a1", "read")).toBe(false);
		expect(await can("u12", "temp", "t1", "use")).toBe(true);
	});

	it("treats corrupt effects as deny", async () => {
		expect(await can("u13", "weird", "w1", "x")).toBe(false);
	});

	it("never reaches unknown subject kinds", async () => {
		expect(await can("u14", "alien", "al1", "read")).toBe(false);
	});

	it("cuts role expansion at the depth cap", async () => {
		// deep0 expands 4 times (deep0→deep1→deep2→deep3→deep4);
		// deep4 sits at depth 4 and is never expanded, so u22 — a
		// member of deep4 — is unreachable.
		expect(await can("u22", "deep", "d1", "x")).toBe(false);
		// The expiring role grant still resolves while live.
		expect(await can("u21", "note", "n3", "read")).toBe(true);
	});

	it("re-resolves object checks after an epoch bump", async () => {
		const p = buildPermissions(db);
		const asUser = (objectId: string) =>
			Effect.runPromise(
				p
					.canObject("patient", objectId, "read")
					.pipe(Effect.provideService(Principal, { userId: "u20" })),
			);
		expect(await asUser("px-epoch")).toBe(false);
		await writeRelationTuple(db, {
			objectType: "patient",
			objectId: "px-epoch",
			relation: "read",
			subjectKind: "user",
			subjectId: "u20",
		});
		expect(await asUser("px-epoch")).toBe(true);
	});

	it("re-resolves object checks once a cached expiry passes", async () => {
		const t0 = Date.now();
		await writeRelationTuple(db, {
			objectType: "temp",
			objectId: "t2",
			relation: "use",
			subjectKind: "user",
			subjectId: "u23",
			expiresAt: new Date(t0 + 5_000),
		});
		const p = buildPermissions(db);
		const check = () =>
			Effect.runPromise(
				p.canObject("temp", "t2", "use").pipe(Effect.provideService(Principal, { userId: "u23" })),
			);
		const now = vi.spyOn(Date, "now").mockReturnValue(t0);
		try {
			expect(await check()).toBe(true);
			// Warm hit while the expiry is still in the future.
			expect(await check()).toBe(true);
			// Exactly at expires_at the grant is gone — the cached entry's
			// notAfter boundary forces a re-resolve.
			now.mockReturnValue(t0 + 5_000);
			expect(await check()).toBe(false);
		} finally {
			now.mockRestore();
		}
	});

	it("clears the object cache once it reaches the bound", async () => {
		const p = buildPermissions(db);
		for (let i = 0; i < 1001; i++) {
			await Effect.runPromise(
				p
					.canObject("patient", `bulk-${i}`, "read")
					.pipe(Effect.provideService(Principal, { userId: "u1" })),
			);
		}
		// Entries were evicted wholesale; resolution still works.
		expect(
			await Effect.runPromise(
				p
					.canObject("patient", "p1", "read")
					.pipe(Effect.provideService(Principal, { userId: "u1" })),
			),
		).toBe(true);
	});

	it("fails closed with no Principal", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const p = buildPermissions(db);
				return {
					can: yield* p.canObject("patient", "p1", "read"),
					err: yield* Effect.flip(p.requireObject("patient", "p1", "read")),
				};
			}),
		);
		expect(result.can).toBe(false);
		expect(result.err).toBeInstanceOf(Forbidden);
		expect(result.err.path).toBe("rbac.patient.p1.read");
	});

	it("requireObject succeeds on allow and fails Forbidden on deny", async () => {
		// u1 holds patient.p1.read → requireObject resolves.
		await Effect.runPromise(
			buildPermissions(db)
				.requireObject("patient", "p1", "read")
				.pipe(Effect.provideService(Principal, { userId: "u1" })),
		);
		// u3's note.n1.read is denied → Forbidden with the object path.
		const denied = await Effect.runPromise(
			Effect.flip(
				buildPermissions(db)
					.requireObject("note", "n1", "read")
					.pipe(Effect.provideService(Principal, { userId: "u3" })),
			),
		);
		expect(denied).toBeInstanceOf(Forbidden);
		expect(denied.path).toBe("rbac.note.n1.read");
	});
});

describe("relation tuple writes", () => {
	let db: DbClient;

	beforeAll(async () => {
		db = makeDb(makeD1(DDL));
	});

	it("writeRelationTuple inserts then upserts by natural key and bumps the epoch", async () => {
		const before = await readEpoch(db);
		await writeRelationTuple(db, {
			objectType: "patient",
			objectId: "px",
			relation: "owner",
			subjectKind: "user",
			subjectId: "owner-1",
		});
		expect(await readEpoch(db)).toBe(before + 1);
		let rows = await db.select().from(relationTuples).where(eq(relationTuples.objectId, "px"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.effect).toBe("allow");
		expect(rows[0]?.tenantId).toBeNull();
		expect(rows[0]?.expiresAt).toBeNull();
		expect(rows[0]?.grantedBy).toBeNull();
		const firstId = rows[0]?.id;

		// Same natural key → update in place, no duplicate row.
		// (tenantId is part of the key, so it stays null here.)
		await writeRelationTuple(db, {
			objectType: "patient",
			objectId: "px",
			relation: "owner",
			subjectKind: "user",
			subjectId: "owner-1",
			effect: "deny",
			expiresAt: new Date(1_700_000_000_000),
			grantedBy: "admin",
		});
		expect(await readEpoch(db)).toBe(before + 2);
		rows = await db.select().from(relationTuples).where(eq(relationTuples.objectId, "px"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(firstId);
		expect(rows[0]?.effect).toBe("deny");
		expect(rows[0]?.tenantId).toBeNull();
		expect(rows[0]?.grantedBy).toBe("admin");
		expect(rows[0]?.expiresAt?.getTime()).toBe(1_700_000_000_000);
	});

	it("writeRelationTuple treats NULL tenant as a distinct natural key", async () => {
		await writeRelationTuple(db, {
			objectType: "patient",
			objectId: "py",
			relation: "read",
			subjectKind: "group",
			subjectId: "g1",
		});
		await writeRelationTuple(db, {
			objectType: "patient",
			objectId: "py",
			relation: "read",
			subjectKind: "group",
			subjectId: "g1",
			tenantId: "t1",
		});
		const rows = await db.select().from(relationTuples).where(eq(relationTuples.objectId, "py"));
		expect(rows).toHaveLength(2);
	});

	it("deleteRelationTuples filters and returns the count", async () => {
		const epochBefore = await readEpoch(db);
		// tenantId: null matches only global rows.
		const globalDeleted = await deleteRelationTuples(db, {
			objectType: "patient",
			objectId: "py",
			subjectId: "g1",
			tenantId: null,
		});
		expect(globalDeleted).toBe(1);
		expect(await readEpoch(db)).toBe(epochBefore + 1);
		// tenantId: "t1" matches the tenant-scoped row.
		expect(
			await deleteRelationTuples(db, {
				objectType: "patient",
				objectId: "py",
				tenantId: "t1",
			}),
		).toBe(1);
		// tenantId omitted = any tenant; objectId omitted = any object.
		await writeRelationTuple(db, {
			objectType: "note",
			objectId: "n-del",
			relation: "read",
			subjectKind: "user",
			subjectId: "gone",
		});
		await writeRelationTuple(db, {
			objectType: "note",
			objectId: "n-del",
			relation: "read",
			subjectKind: "user",
			subjectId: "gone",
			tenantId: "t9",
		});
		expect(
			await deleteRelationTuples(db, {
				objectType: "note",
				relation: "read",
				subjectKind: "user",
				subjectId: "gone",
			}),
		).toBe(2);
	});

	it("deleteRelationTuples does not bump the epoch on zero matches", async () => {
		const epochBefore = await readEpoch(db);
		const count = await deleteRelationTuples(db, {
			objectType: "patient",
			objectId: "does-not-exist",
		});
		expect(count).toBe(0);
		expect(await readEpoch(db)).toBe(epochBefore);
	});
});
