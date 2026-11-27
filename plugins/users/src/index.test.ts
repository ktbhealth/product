import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Query } from "@effect-server-utils/cqrs";

import { adminAudit, AuditLive } from "@ktb/audit";
import { Accounts, Auth } from "@ktb/auth";
import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { Forbidden, Principal } from "@ktb/authz";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { UserCogIcon } from "lucide-react";

import { UsersQueries } from "./api.ts";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";

import {
	listAllUsers,
	Users,
	UsersLive,
	UsersQueriesLive,
	usersChromePlugin,
	usersPanelPlugin,
	usersServicesPlugin,
	plugins,
} from "./index.ts";

// Seed rows only — schema comes from the real migrations via makeTestD1.
const DDL = `
INSERT INTO "user" (id, name, email, email_verified, image, banned, created_at, updated_at) VALUES
  ('u1', 'Admin', 'admin@x.com', 1, NULL, 0, 1000, 1000),
  ('u2', 'Doc', 'doc@x.com', 0, NULL, 0, 2000, 2000),
  ('u3', 'Banned', 'banned@x.com', 1, NULL, 1, 3000, 3000);
INSERT INTO patients (owner_id, name, created_at) VALUES ('u2', 'Ana', 0), ('u2', 'Bia', 0);
INSERT INTO consultations (user_id, status, transcript, created_at) VALUES ('u2', 'done', '', 0), ('u1', 'live', '', 0);
`;

describe("users repo", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeTestD1(DDL));
	});

	it("counts zero for a user with no patients and no consultations", async () => {
		const empty = makeDb(
			makeTestD1(`
INSERT INTO "user" (id, name, email, email_verified, image, banned, created_at, updated_at) VALUES ('u9', 'New', 'new@x.com', 0, NULL, 0, 3000, 3000);
`),
		);
		const [row] = await listAllUsers(empty);
		expect(row).toMatchObject({ id: "u9", patientCount: 0, consultationCount: 0 });
	});

	it("listAllUsers returns users newest-first with aggregate counts", async () => {
		const rows = await listAllUsers(db);
		expect(rows.map((r) => r.id)).toEqual(["u3", "u2", "u1"]);
		expect(rows.find((r) => r.id === "u3")?.banned).toBe(true);
		const doc = rows.find((r) => r.id === "u2")!;
		expect(doc.banned).toBe(false);
		expect(doc.patientCount).toBe(2);
		expect(doc.consultationCount).toBe(1);
		const admin = rows.find((r) => r.id === "u1")!;
		expect(admin.patientCount).toBe(0);
		expect(admin.consultationCount).toBe(1);
		expect(admin.emailVerified).toBe(true);
		expect(doc.emailVerified).toBe(false);
	});
});

describe("UsersLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Users, never>;
	let db: ReturnType<typeof makeDb>;
	const setUserBanned = vi.fn(async (_userId: string, _banned: boolean) => {});
	const createVerified = vi.fn(
		async (
			_input: unknown,
		): Promise<
			{ ok: true; userId: string } | { ok: false; error: "exists" | "invalid_password" }
		> => ({ ok: true, userId: "u9" }),
	);
	const updateUser = vi.fn(
		async (
			_userId: string,
			_fields: unknown,
		): Promise<{ ok: true } | { ok: false; error: "exists" }> => ({ ok: true }),
	);
	const deleteUser = vi.fn(async (_userId: string) => {});

	beforeAll(() => {
		db = makeDb(makeTestD1(DDL));
		const deps = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(Auth, {
				getSession: async () => null,
				setUserBanned,
				updateUser,
				deleteUser,
			}),
			Layer.succeed(Accounts, { createVerified }),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		// The audit plugin is optional — provide the real AuditLive over
		// the same db so mutations write admin_audit rows (T-037).
		const allDeps = Layer.mergeAll(deps, AuditLive.pipe(Layer.provide(deps)));
		runtime = ManagedRuntime.make(UsersLive.pipe(Layer.provideMerge(allDeps)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Users>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (p: Users["Service"]) => Effect.Effect<A, E>) => Effect.flatMap(Users, f);

	it("adminList returns all users with isAdmin resolved by the gate", async () => {
		const rows = await asUser(
			"u1",
			call((p) => p.adminList()),
			"admin@x.com",
		);
		expect(rows).toHaveLength(3);
		expect(rows.find((r) => r.email === "admin@x.com")?.isAdmin).toBe(true);
		expect(rows.find((r) => r.email === "doc@x.com")?.isAdmin).toBe(false);
	});

	it("adminList fails Forbidden for non-admin email and null principal", async () => {
		await expect(
			asUser(
				"u2",
				call((p) => p.adminList()),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "platform.admin" });
		await expect(
			asUser(
				null,
				call((p) => p.adminList()),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("adminSetSuspended delegates suspend/reactivate to the Auth port", async () => {
		setUserBanned.mockClear();
		await asUser(
			"u1",
			call((p) => p.adminSetSuspended("u2", true)),
			"admin@x.com",
		);
		expect(setUserBanned).toHaveBeenCalledWith("u2", true);
		await asUser(
			"u1",
			call((p) => p.adminSetSuspended("u2", false)),
			"admin@x.com",
		);
		expect(setUserBanned).toHaveBeenCalledWith("u2", false);
		expect(setUserBanned).toHaveBeenCalledTimes(2);
	});

	it("adminSetSuspended writes suspend/reactivate audit rows", async () => {
		setUserBanned.mockClear();
		await asUser(
			"u1",
			call((p) => p.adminSetSuspended("u3", true)),
			"admin@x.com",
		);
		await asUser(
			"u1",
			call((p) => p.adminSetSuspended("u3", false)),
			"admin@x.com",
		);
		const rows = await db.select().from(adminAudit);
		// The delegate test above also audits u2 — scope to u3.
		const mine = rows.filter((r) => r.targetId === "u3");
		const suspend = mine.find((r) => r.action === "users.suspend")!;
		const reactivate = mine.find((r) => r.action === "users.reactivate")!;
		for (const row of [suspend, reactivate]) {
			expect(row).toMatchObject({
				actorUserId: "u1",
				actorEmail: "admin@x.com",
				targetType: "user",
				targetId: "u3",
			});
		}
	});

	it("adminCreate delegates to the Accounts port and audits the create", async () => {
		createVerified.mockClear();
		const res = await asUser(
			"u1",
			call((p) => p.adminCreate({ email: "New@X.com ", name: "New", password: "s3cret-pass" })),
			"admin@x.com",
		);
		expect(res).toEqual({ ok: true, userId: "u9" });
		expect(createVerified).toHaveBeenCalledWith({
			email: "New@X.com ",
			name: "New",
			password: "s3cret-pass",
		});
		const rows = await db.select().from(adminAudit);
		const created = rows.find((r) => r.action === "users.create");
		expect(created).toMatchObject({
			actorUserId: "u1",
			actorEmail: "admin@x.com",
			targetType: "user",
			targetId: "u9",
		});
	});

	it("adminCreate surfaces port rejections without auditing", async () => {
		createVerified.mockResolvedValueOnce({ ok: false, error: "exists" });
		const res = await asUser(
			"u1",
			call((p) => p.adminCreate({ email: "doc@x.com", name: "Doc", password: "s3cret-pass" })),
			"admin@x.com",
		);
		expect(res).toEqual({ ok: false, error: "exists" });
		createVerified.mockResolvedValueOnce({ ok: false, error: "invalid_password" });
		const res2 = await asUser(
			"u1",
			call((p) => p.adminCreate({ email: "n@x.com", name: "N", password: "x" })),
			"admin@x.com",
		);
		expect(res2).toEqual({ ok: false, error: "invalid_password" });
		const rows = await db.select().from(adminAudit);
		expect(rows.filter((r) => r.action === "users.create")).toHaveLength(1);
	});

	it("adminCreate fails Forbidden for non-admin email and null principal", async () => {
		createVerified.mockClear();
		await expect(
			asUser(
				"u2",
				call((p) => p.adminCreate({ email: "n@x.com", name: "N", password: "s3cret-pass" })),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "platform.admin" });
		await expect(
			asUser(
				null,
				call((p) => p.adminCreate({ email: "n@x.com", name: "N", password: "s3cret-pass" })),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		expect(createVerified).not.toHaveBeenCalled();
	});

	it("adminSetSuspended fails Forbidden for non-admin email and null principal", async () => {
		setUserBanned.mockClear();
		await expect(
			asUser(
				"u2",
				call((p) => p.adminSetSuspended("u1", true)),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "platform.admin" });
		await expect(
			asUser(
				null,
				call((p) => p.adminSetSuspended("u1", true)),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		expect(setUserBanned).not.toHaveBeenCalled();
	});

	it("adminUpdate delegates to the Auth port and writes an audit row", async () => {
		updateUser.mockClear();
		const res = await asUser(
			"u1",
			call((p) => p.adminUpdate("u2", { name: "Doc Two", email: "doc2@x.com" })),
			"admin@x.com",
		);
		expect(res).toEqual({ ok: true });
		expect(updateUser).toHaveBeenCalledWith("u2", { name: "Doc Two", email: "doc2@x.com" });
		const rows = await db.select().from(adminAudit);
		const row = rows.find((r) => r.action === "users.update" && r.targetId === "u2")!;
		expect(row).toMatchObject({ actorUserId: "u1", targetType: "user" });
	});

	it("adminUpdate surfaces the port's exists rejection without auditing", async () => {
		updateUser.mockResolvedValueOnce({ ok: false, error: "exists" });
		const res = await asUser(
			"u1",
			call((p) => p.adminUpdate("u2", { name: "Doc", email: "taken@x.com" })),
			"admin@x.com",
		);
		expect(res).toEqual({ ok: false, error: "exists" });
		const rows = await db.select().from(adminAudit);
		expect(rows.filter((r) => r.action === "users.update" && r.targetId === "u2")).toHaveLength(1);
	});

	it("adminUpdate fails Forbidden for non-admin principals", async () => {
		updateUser.mockClear();
		await expect(
			asUser(
				"u2",
				call((p) => p.adminUpdate("u1", { name: "X", email: "x@x.com" })),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		expect(updateUser).not.toHaveBeenCalled();
	});

	it("adminDelete delegates to the Auth port and writes an audit row", async () => {
		deleteUser.mockClear();
		const res = await asUser(
			"u1",
			call((p) => p.adminDelete("u2")),
			"admin@x.com",
		);
		expect(res).toEqual({ ok: true });
		expect(deleteUser).toHaveBeenCalledWith("u2");
		const rows = await db.select().from(adminAudit);
		const row = rows.find((r) => r.action === "users.delete" && r.targetId === "u2")!;
		expect(row).toMatchObject({ actorUserId: "u1", targetType: "user" });
	});

	it("adminDelete refuses targets that hold the admin gate", async () => {
		deleteUser.mockClear();
		// u1 is admin@x.com — allowlisted by the test gate.
		const res = await asUser(
			"u1",
			call((p) => p.adminDelete("u1")),
			"admin@x.com",
		);
		expect(res).toEqual({ ok: false, error: "is_admin" });
		expect(deleteUser).not.toHaveBeenCalled();
	});

	it("adminDelete is a no-op success for a missing user", async () => {
		deleteUser.mockClear();
		const res = await asUser(
			"u1",
			call((p) => p.adminDelete("ghost")),
			"admin@x.com",
		);
		expect(res).toEqual({ ok: true });
		expect(deleteUser).toHaveBeenCalledWith("ghost");
	});

	it("adminDelete fails Forbidden for non-admin principals", async () => {
		deleteUser.mockClear();
		await expect(
			asUser(
				"u2",
				call((p) => p.adminDelete("u1")),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		expect(deleteUser).not.toHaveBeenCalled();
	});
});

describe("plugins", () => {
	it("declares services and panel as single-concern plugins", () => {
		expect(usersServicesPlugin.id).toBe("users.services");
		expect(usersServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
		expect(usersServicesPlugin.services).toBeDefined();
		expect(usersPanelPlugin.id).toBe("users.panel");
		expect(usersPanelPlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(usersPanelPlugin.panel?.pages?.[0]?.path).toBe("/platform/users");
		expect(usersChromePlugin.id).toBe("users.chrome");
		expect(usersChromePlugin.chrome).toEqual([
			{
				id: "users.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: { to: "/platform/users", label: "Users", icon: UserCogIcon, group: "Identity" },
				},
			},
		]);
	});

	describe("panel page loader", () => {
		const loader = usersPanelPlugin.panel!.pages![0]!.loader as () => Effect.Effect<
			unknown,
			never,
			Users
		>;
		const withUsers = (adminList: Users["Service"]["adminList"]) =>
			Effect.runPromise(
				loader().pipe(Effect.provideService(Users, { adminList } as unknown as Users["Service"])),
			);

		it("returns the user listing for admins", async () => {
			const rows = [{ id: "u1" }];
			expect(await withUsers(() => Effect.succeed(rows as never))).toEqual(rows);
		});

		it("collapses Forbidden to an empty table", async () => {
			expect(await withUsers(() => Effect.fail(new Forbidden({ path: "platform.admin" })))).toEqual(
				[],
			);
		});
	});

	it("contributes no routes, tables or top-nav", () => {
		expect("routes" in usersServicesPlugin).toBe(false);
		expect("tables" in usersServicesPlugin).toBe(false);
		expect("routes" in usersPanelPlugin).toBe(false);
		expect("chrome" in usersPanelPlugin).toBe(false);
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual(["users.services", "users.chrome", "users.panel"]);
	});
});

describe("UsersQueriesLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<never, never>;

	beforeAll(() => {
		runtime = ManagedRuntime.make(
			UsersQueriesLive.pipe(Layer.provideMerge(Layer.succeed(Db, makeDb(makeTestD1(DDL))))),
		) as unknown as ManagedRuntime.ManagedRuntime<never, never>;
	});

	afterAll(() => runtime.dispose());

	const get = (id: string) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const queries = yield* Query.dispatcher(UsersQueries);
				return yield* queries["users.get"]({ id });
			}).pipe(Effect.scoped) as never,
		);

	it("users.get returns the raw user row", async () => {
		await expect(get("u2")).resolves.toEqual({ id: "u2", email: "doc@x.com", name: "Doc" });
	});

	it("users.get returns null for an unknown id", async () => {
		await expect(get("nobody")).resolves.toBeNull();
	});
});
