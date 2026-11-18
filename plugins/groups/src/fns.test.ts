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

import { groupsServicesPlugin } from "./index.ts";
import {
	addGroupMemberFn,
	createGroupFn,
	deleteGroupFn,
	listGroupMembersFn,
	removeGroupMemberFn,
} from "./fns.ts";

const DDL = `
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, zk INTEGER NOT NULL DEFAULT 0);
INSERT INTO groups (name, slug, kind, meta, created_at, updated_at) VALUES
  ('Clinic A', 'clinic-a', 'clinic', NULL, 1000, 1000);
CREATE TABLE group_members (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, member_kind TEXT NOT NULL, member_id TEXT NOT NULL, role TEXT, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX group_members_group_member_idx ON group_members (group_id, member_kind, member_id);
INSERT INTO group_members (group_id, member_kind, member_id, role, created_at) VALUES
  (1, 'user', 'u1', 'admin', 1000);
`;

describe("groups admin fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;

	beforeAll(async () => {
		const db = makeDb(makeD1(DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const services = groupsServicesPlugin.services as Layer.Layer<unknown, unknown, unknown>;
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
		await expect(createGroupFn({ data: { name: "x", slug: "x", kind: "k" } })).rejects.toThrow(
			"unauthenticated",
		);
	});

	it("denies non-admin principals on every admin fn", async () => {
		currentEmail = "user@x.com";
		const results = await Promise.all([
			createGroupFn({ data: { name: "n", slug: "n", kind: "k" } }),
			deleteGroupFn({ data: { id: 1 } }),
			listGroupMembersFn({ data: { groupId: 1 } }),
			addGroupMemberFn({ data: { groupId: 1, memberKind: "user", memberId: "u2" } }),
			removeGroupMemberFn({ data: { groupId: 1, memberKind: "user", memberId: "u1" } }),
		]);
		for (const res of results) expect(res).toEqual({ ok: false });
	});

	it("runs the full admin lifecycle", async () => {
		currentEmail = "admin@x.com";
		const created = await createGroupFn({
			data: { name: "Cohort", slug: "cohort-1", kind: "cohort", meta: '{"k":1}' },
		});
		expect(created.ok).toBe(true);
		const groupId = (created as { data: { id: number } }).data.id;

		const empty = await listGroupMembersFn({ data: { groupId } });
		expect(empty.ok && empty.data).toEqual([]);

		const added = await addGroupMemberFn({
			data: { groupId, memberKind: "user", memberId: "u9", role: "lead" },
		});
		expect(added.ok).toBe(true);
		const members = await listGroupMembersFn({ data: { groupId } });
		expect(members.ok && members.data.map((m) => m.memberId)).toEqual(["u9"]);

		// Role optional → stored as null.
		expect(
			(
				await addGroupMemberFn({
					data: { groupId, memberKind: "group", memberId: "g1" },
				})
			).ok,
		).toBe(true);

		expect(
			(
				await removeGroupMemberFn({
					data: { groupId, memberKind: "user", memberId: "u9" },
				})
			).ok,
		).toBe(true);
		// Unknown membership → ok:false.
		expect(
			(
				await removeGroupMemberFn({
					data: { groupId, memberKind: "user", memberId: "ghost" },
				})
			).ok,
		).toBe(false);

		expect((await deleteGroupFn({ data: { id: groupId } })).ok).toBe(true);
		// Already gone → ok:false.
		expect((await deleteGroupFn({ data: { id: groupId } })).ok).toBe(false);
	});
});
