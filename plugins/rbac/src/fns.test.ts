import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { rbacServicesPlugin } from "./index.ts";
import {
	assignSubjectFn,
	createRoleFn,
	deleteRoleFn,
	revokeRolePermissionFn,
	setRolePermissionFn,
	unassignSubjectFn,
	updateRoleFn,
} from "./fns.ts";

const DDL = `
CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE role_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, resource TEXT NOT NULL, action TEXT NOT NULL, effect TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX role_permissions_role_resource_action_idx ON role_permissions (role_id, resource, action);
CREATE TABLE subject_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, tenant_id TEXT, granted_by TEXT, expires_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX subject_roles_subject_idx ON subject_roles (subject_kind, subject_id);
CREATE TABLE permission_epoch (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE relation_tuples (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, effect TEXT NOT NULL, tenant_id TEXT, expires_at INTEGER, granted_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE group_members (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, member_kind TEXT NOT NULL, member_id TEXT NOT NULL, role TEXT, created_at INTEGER NOT NULL);
`;

describe("rbac admin fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;

	beforeAll(async () => {
		const db = makeDb(makeD1(DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const services = rbacServicesPlugin.services as Layer.Layer<unknown, unknown, unknown>;
		runtime = ManagedRuntime.make(
			services.pipe(Layer.provide(env)) as unknown as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(
			runtime,
			stubAuth(() => sessionUser(currentEmail)),
		);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(createRoleFn({ data: { name: "x" } })).rejects.toThrow("unauthenticated");
	});

	it("denies non-admin principals", async () => {
		currentEmail = "user@x.com";
		const res = await createRoleFn({ data: { name: "nurse" } });
		expect(res).toEqual({ ok: false });
	});

	it("collapses Forbidden to ok:false for every admin fn", async () => {
		currentEmail = "user@x.com";
		const results = await Promise.all([
			createRoleFn({ data: { name: "nurse" } }),
			updateRoleFn({ data: { id: 1, name: "nurse" } }),
			deleteRoleFn({ data: { id: 1 } }),
			setRolePermissionFn({
				data: { roleId: 1, resource: "patient", action: "read", effect: "allow" },
			}),
			revokeRolePermissionFn({ data: { roleId: 1, resource: "patient", action: "read" } }),
			assignSubjectFn({
				data: { subjectKind: "user", subjectId: "u1", roleId: 1 },
			}),
			unassignSubjectFn({ data: { id: 1 } }),
		]);
		for (const res of results) expect(res).toEqual({ ok: false });
	});

	it("runs the full admin lifecycle", async () => {
		currentEmail = "admin@x.com";
		const created = await createRoleFn({ data: { name: "auditor", description: "RO" } });
		expect(created.ok).toBe(true);
		const roleId = (created as { data: { id: number } }).data.id;

		expect(
			(
				await setRolePermissionFn({
					data: { roleId, resource: "patient", action: "read", effect: "allow" },
				})
			).ok,
		).toBe(true);
		expect(
			(
				await revokeRolePermissionFn({
					data: { roleId, resource: "patient", action: "read" },
				})
			).ok,
		).toBe(true);

		const assigned = await assignSubjectFn({
			data: {
				subjectKind: "user",
				subjectId: "u1",
				roleId,
				tenantId: "t1",
				expiresAt: "2030-01-01T00:00:00.000Z",
			},
		});
		expect(assigned.ok).toBe(true);
		const assignmentId = (assigned as { data: { id: number } }).data.id;

		expect((await updateRoleFn({ data: { id: roleId, description: "RO2" } })).ok).toBe(true);
		// Unknown role → ok:false (null row).
		expect((await updateRoleFn({ data: { id: 9999, name: "ghost" } })).ok).toBe(false);

		expect((await unassignSubjectFn({ data: { id: assignmentId } })).ok).toBe(true);
		expect((await deleteRoleFn({ data: { id: roleId } })).ok).toBe(true);
	});
});
