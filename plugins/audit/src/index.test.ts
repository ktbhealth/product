import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Forbidden, Principal } from "@ktb/authz";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { Permissions } from "@ktb/rbac";
import { Tenant } from "@ktb/tenant";

import { eq } from "drizzle-orm";

import { adminAudit } from "./schema.ts";
import {
	AUDIT_TEST_DDL,
	Audit,
	AuditLive,
	audit,
	auditChromePlugin,
	auditEntryHash,
	auditPanelPlugin,
	auditServicesPlugin,
	auditTablesPlugin,
	insertAuditEntry,
	listAuditEntries,
	listPatientAuditEntries,
	listTenantAuditEntries,
	PatientAuditAccess,
	plugins,
	verifyAuditChain,
	type AuditListResult,
} from "./index.ts";

// admin_audit.tenant_id references groups.id — the FK is declared for
// documentation; better-sqlite3 does not enforce it, but the parent
// table exists in every real database, so the test DDL mirrors that.
const GROUPS_DDL = `
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, zk INTEGER NOT NULL DEFAULT 0);
INSERT INTO groups (name, slug, kind, meta, created_at, updated_at) VALUES ('Clinic A', 'clinic-a', 'clinic', NULL, 1000, 1000);
`;

const DDL = GROUPS_DDL + AUDIT_TEST_DDL;

// Patient feed (P-086): the consultations join needs only id +
// patient_id — the WHERE never touches the clinical columns. Rows are
// seeded through the D1 shim's exec (the drizzle insert would demand
// every notNull column of the real table).
const CONSULTATIONS_DDL = `
CREATE TABLE consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER);
INSERT INTO consultations (id, patient_id) VALUES (10, 5), (11, 6), (12, NULL);
`;
const PATIENT_DDL = GROUPS_DDL + AUDIT_TEST_DDL + CONSULTATIONS_DDL;

describe("audit repo", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
	});

	it("insertAuditEntry writes a row with actor, normalized tenant and stringified target", async () => {
		const row = await insertAuditEntry(db, {
			actorUserId: "u1",
			actorEmail: "admin@x.com",
			action: "users.suspend",
			targetType: "user",
			targetId: 42,
			detail: { suspended: true },
			tenantId: "1",
		});
		expect(row).not.toBeNull();
		expect(row!.actorUserId).toBe("u1");
		expect(row!.actorEmail).toBe("admin@x.com");
		expect(row!.action).toBe("users.suspend");
		expect(row!.targetType).toBe("user");
		expect(row!.targetId).toBe("42");
		expect(row!.detail).toBe('{"suspended":true}');
		expect(row!.tenantId).toBe(1);
	});

	it("normalizes every tenantId shape and drops non-numeric values", async () => {
		const base = { actorUserId: null, actorEmail: null, action: "a.b" };
		const cases: Array<[string | number | null | undefined, number | null]> = [
			[7, 7],
			["8", 8],
			["", null],
			["  ", null],
			["abc", null],
			[1.5, null],
			[null, null],
			[undefined, null],
		];
		for (const [input, expected] of cases) {
			const row = await insertAuditEntry(db, { ...base, tenantId: input });
			expect(row!.tenantId).toBe(expected);
		}
	});

	it("stores null detail when absent and truncates oversized payloads", async () => {
		const noDetail = await insertAuditEntry(db, {
			actorUserId: null,
			actorEmail: null,
			action: "a.b",
		});
		expect(noDetail!.detail).toBeNull();
		expect(noDetail!.targetType).toBeNull();
		expect(noDetail!.targetId).toBeNull();
		const big = await insertAuditEntry(db, {
			actorUserId: null,
			actorEmail: null,
			action: "a.b",
			detail: { blob: "x".repeat(5000) },
		});
		expect(big!.detail!.length).toBe(4000);
	});

	it("returns null when the driver yields no RETURNING row", async () => {
		const emptyInsert = {
			select: () => ({
				from: () => ({ orderBy: () => ({ limit: async () => [] }) }),
			}),
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as DbClient;
		expect(
			await insertAuditEntry(emptyInsert, {
				actorUserId: null,
				actorEmail: null,
				action: "a.b",
			}),
		).toBeNull();
	});

	it("listAuditEntries returns newest-first rows with the total count", async () => {
		const fresh = makeDb(makeD1(DDL));
		await insertAuditEntry(fresh, {
			actorUserId: "u1",
			actorEmail: "a@x.com",
			action: "first.action",
		});
		await insertAuditEntry(fresh, {
			actorUserId: "u2",
			actorEmail: "b@x.com",
			action: "second.action",
		});
		const result = await listAuditEntries(fresh);
		expect(result.entries.map((e) => e.action)).toEqual(["second.action", "first.action"]);
		expect(result.total).toBe(2);
		expect(result.limit).toBe(200);
	});

	it("clamps the page limit and reports zero totals on empty drivers", async () => {
		const fresh = makeDb(makeD1(DDL));
		for (let i = 0; i < 3; i++) {
			await insertAuditEntry(fresh, {
				actorUserId: null,
				actorEmail: null,
				action: `a.${i}`,
			});
		}
		expect((await listAuditEntries(fresh, { limit: 2 })).entries).toHaveLength(2);
		expect((await listAuditEntries(fresh, { limit: 0 })).entries).toHaveLength(1);
		expect((await listAuditEntries(fresh, { limit: 9999 })).limit).toBe(500);
	});

	it("reports a zero total when the count query yields no row", async () => {
		// Thenable query stub: `select().from()` is awaited directly for
		// the count and chained through orderBy/limit for the page.
		const query = {
			orderBy: () => ({ limit: async () => [] }),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
		};
		const fakeDb = { select: () => ({ from: () => query }) } as unknown as DbClient;
		const result = await listAuditEntries(fakeDb);
		expect(result).toEqual({ entries: [], total: 0, limit: 200 });
	});
});

describe("listTenantAuditEntries", () => {
	it("returns only the tenant's rows, newest-first — NULL tenant excluded", async () => {
		const fresh = makeDb(makeD1(DDL));
		const write = (action: string, tenantId?: string | number | null) =>
			insertAuditEntry(fresh, {
				actorUserId: null,
				actorEmail: null,
				action,
				tenantId,
			});
		await write("feed.t1.first", 1);
		await write("feed.t1.second", "1");
		await write("feed.t2", 2);
		await write("feed.global");
		const result = await listTenantAuditEntries(fresh, 1);
		expect(result.entries.map((e) => e.action)).toEqual(["feed.t1.second", "feed.t1.first"]);
		expect(result.total).toBe(2);
		expect(result.limit).toBe(200);
	});

	it("clamps the page limit like the admin listing", async () => {
		const fresh = makeDb(makeD1(DDL));
		for (let i = 0; i < 3; i++) {
			await insertAuditEntry(fresh, {
				actorUserId: null,
				actorEmail: null,
				action: `feed.${i}`,
				tenantId: 7,
			});
		}
		expect((await listTenantAuditEntries(fresh, 7, { limit: 2 })).entries).toHaveLength(2);
		expect((await listTenantAuditEntries(fresh, 7, { limit: 0 })).entries).toHaveLength(1);
		expect((await listTenantAuditEntries(fresh, 7, { limit: 9999 })).limit).toBe(500);
	});

	it("reports a zero total when the count query yields no row", async () => {
		// Same thenable stub as the admin listing, plus the tenant
		// `where` fence both queries now chain through.
		const query = {
			where: () => query,
			orderBy: () => ({ limit: async () => [] }),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
		};
		const fakeDb = { select: () => ({ from: () => query }) } as unknown as DbClient;
		const result = await listTenantAuditEntries(fakeDb, 1);
		expect(result).toEqual({ entries: [], total: 0, limit: 200 });
	});
});

describe("audit chain (T-139)", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeD1(DDL));
	});

	const write = (action: string) =>
		insertAuditEntry(db, { action, actorUserId: "u", actorEmail: "a@x.com" });

	it("chains each insert to the previous row's hash", async () => {
		const first = (await write("chain.one"))!;
		const second = (await write("chain.two"))!;
		expect(first.prevHash).toBeNull();
		expect(second.prevHash).toBe(await auditEntryHash(first));
		// The second row's own hash (implicitly committed by the NEXT
		// row's prev_hash) covers its prevHash — history-committed.
		const third = (await write("chain.three"))!;
		expect(third.prevHash).toBe(await auditEntryHash(second));
	});

	it("verifies a clean log and an empty one", async () => {
		expect(await verifyAuditChain(db)).toMatchObject({ status: "verified" });
		const empty = makeDb(makeD1(DDL));
		expect(await verifyAuditChain(empty)).toEqual({
			status: "empty",
			entries: 0,
			brokenAt: null,
		});
	});

	it("accepts an unchained legacy prefix (pre-column rows)", async () => {
		const legacy = makeDb(makeD1(DDL));
		// Legacy row written before prev_hash existed — NULL link.
		await legacy.insert(adminAudit).values({ action: "legacy.one", createdAt: new Date(0) });
		// The first post-migration row chains onto the legacy row's hash.
		const chained = (await insertAuditEntry(legacy, {
			action: "legacy.two",
			actorUserId: null,
			actorEmail: null,
		}))!;
		expect(chained.prevHash).not.toBeNull();
		expect(await verifyAuditChain(legacy)).toMatchObject({
			status: "verified",
			entries: 2,
		});
	});

	it("detects a rewritten historical row", async () => {
		const tampered = makeDb(makeD1(DDL));
		const a = (await insertAuditEntry(tampered, {
			action: "t.one",
			actorUserId: null,
			actorEmail: null,
		}))!;
		await insertAuditEntry(tampered, {
			action: "t.two",
			actorUserId: null,
			actorEmail: null,
		});
		// Rewrite row 1 underneath row 2's link.
		await tampered
			.update(adminAudit)
			.set({ action: "t.one.forged" })
			.where(eq(adminAudit.id, a.id));
		const report = await verifyAuditChain(tampered);
		expect(report.status).toBe("tampered");
		expect(report.brokenAt).not.toBeNull();
	});

	it("detects a de-chained row via the next link", async () => {
		// Nulling a TAIL row's prev_hash is indistinguishable from a
		// legacy prefix — the tamper surfaces at the NEXT chained row,
		// whose stored link no longer matches the rewritten predecessor.
		const tampered = makeDb(makeD1(DDL));
		await insertAuditEntry(tampered, { action: "d.one", actorUserId: null, actorEmail: null });
		const second = (await insertAuditEntry(tampered, {
			action: "d.two",
			actorUserId: null,
			actorEmail: null,
		}))!;
		const third = (await insertAuditEntry(tampered, {
			action: "d.three",
			actorUserId: null,
			actorEmail: null,
		}))!;
		await tampered.update(adminAudit).set({ prevHash: null }).where(eq(adminAudit.id, second.id));
		expect(await verifyAuditChain(tampered)).toMatchObject({
			status: "tampered",
			brokenAt: third.id,
		});
	});

	it("detects an unchained row appearing after the chain started", async () => {
		// A NULL prev_hash after the first chained row is tamper evidence
		// in itself — verification stops at that row.
		const tampered = makeDb(makeD1(DDL));
		await insertAuditEntry(tampered, { action: "u.one", actorUserId: null, actorEmail: null });
		await insertAuditEntry(tampered, { action: "u.two", actorUserId: null, actorEmail: null });
		const third = (await insertAuditEntry(tampered, {
			action: "u.three",
			actorUserId: null,
			actorEmail: null,
		}))!;
		await tampered.update(adminAudit).set({ prevHash: null }).where(eq(adminAudit.id, third.id));
		expect(await verifyAuditChain(tampered)).toMatchObject({
			status: "tampered",
			brokenAt: third.id,
		});
	});

	it("rejects a first row that is already chained", async () => {
		// prev_hash on the genesis row has no predecessor to match.
		const tampered = makeDb(makeD1(DDL));
		await tampered
			.insert(adminAudit)
			.values({ action: "g.one", prevHash: "forged", createdAt: new Date(0) });
		expect(await verifyAuditChain(tampered)).toMatchObject({
			status: "tampered",
			entries: 1,
		});
	});

	it("adminVerify gates the walk behind the platform admin", async () => {
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(deps)));
		try {
			const asUser = (email: string | null) =>
				runtime.runPromise(
					Effect.provideService(
						Effect.flatMap(Audit, (p) => p.adminVerify()),
						Principal,
						email === null ? null : { userId: "u", email },
					),
				);
			await expect(asUser("doc@x.com")).rejects.toMatchObject({ _tag: "Forbidden" });
			await expect(asUser(null)).rejects.toMatchObject({ _tag: "Forbidden" });
			await expect(asUser("admin@x.com")).resolves.toMatchObject({ status: "verified" });
		} finally {
			await runtime.dispose();
		}
	});
});

describe("AuditLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Audit, never>;

	beforeAll(() => {
		const db = makeDb(makeD1(DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const asUser = <A, E>(
		userId: string | null,
		effect: Effect.Effect<A, E, Audit>,
		email?: string,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, userId === null ? null : { userId, email }),
		);

	const call = <A, E>(f: (p: Audit["Service"]) => Effect.Effect<A, E>) => Effect.flatMap(Audit, f);

	it("record writes a row stamped with the bound principal", async () => {
		await asUser(
			"admin-1",
			call((p) =>
				p.record({
					action: "groups.delete",
					targetType: "group",
					targetId: 9,
					tenantId: 9,
				}),
			),
			"admin@x.com",
		);
		const result = await asUser(
			"admin-1",
			call((p) => p.adminList()),
			"admin@x.com",
		);
		const row = result.entries.find((e) => e.action === "groups.delete")!;
		expect(row.actorUserId).toBe("admin-1");
		expect(row.actorEmail).toBe("admin@x.com");
		expect(row.targetId).toBe("9");
		expect(row.tenantId).toBe(9);
	});

	it("record attributes delegated actions to the actor (actorId), not userId", async () => {
		// Secretary acting on a doctor's behalf: authz follows userId but
		// the audit row must name the signed-in account.
		await runtime.runPromise(
			Effect.flatMap(Audit, (p) => p.record({ action: "delegated.action" })).pipe(
				Effect.provideService(Principal, {
					userId: "doc-1",
					actorId: "sec-1",
					email: "sec@x.com",
				}),
			),
		);
		const result = await asUser(
			"admin-1",
			call((p) => p.adminList()),
			"admin@x.com",
		);
		const row = result.entries.find((e) => e.action === "delegated.action")!;
		expect(row.actorUserId).toBe("sec-1");
		expect(row.actorEmail).toBe("sec@x.com");
	});

	it("record stamps null actors in system contexts (null principal)", async () => {
		await asUser(
			null,
			call((p) => p.record({ action: "system.action" })),
		);
		const result = await asUser(
			"admin-1",
			call((p) => p.adminList()),
			"admin@x.com",
		);
		const row = result.entries.find((e) => e.action === "system.action")!;
		expect(row.actorUserId).toBeNull();
		expect(row.actorEmail).toBeNull();
	});

	it("adminList is Forbidden for non-admins and null principals", async () => {
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
		).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});
});

describe("Audit activity feed (P-080)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Audit, never>;

	const tenant: Tenant = { id: 1, kind: "clinic", slug: "clinic-a", role: "admin" };

	beforeAll(async () => {
		const db = makeDb(makeD1(DDL));
		const write = (action: string, tenantId?: number | null) =>
			insertAuditEntry(db, { action, actorUserId: null, actorEmail: null, tenantId });
		await write("feed.t1.first", 1);
		await write("feed.t1.second", 1);
		await write("feed.t2", 2);
		await write("feed.global");
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const call = <A, E>(f: (p: Audit["Service"]) => Effect.Effect<A, E>) => Effect.flatMap(Audit, f);

	/** Stub Permissions port: records `can` calls, answers `allowed`. */
	const permissions = (allowed: boolean, seen?: unknown[]) =>
		({
			can: (resource: string, action: string, opts?: unknown) => {
				seen?.push([resource, action, opts]);
				return Effect.succeed(allowed);
			},
		}) as unknown as Permissions["Service"];

	/** Run under a staff principal + tenant scope; `perms` absent means
	 * the rbac plugin is disabled (serviceOption → None). */
	const asStaff = <A, E>(
		effect: Effect.Effect<A, E, Audit>,
		opts: { tenant?: Tenant | null; perms?: Permissions["Service"] } = {},
	) => {
		let eff = effect.pipe(
			Effect.provideService(Principal, { userId: "u1", email: "staff@x.com" }),
			Effect.provideService(Tenant, opts.tenant === undefined ? tenant : opts.tenant),
		);
		if (opts.perms !== undefined) eff = Effect.provideService(eff, Permissions, opts.perms);
		return runtime.runPromise(eff);
	};

	it("activityAccess is true and activityList returns only tenant rows", async () => {
		const seen: unknown[] = [];
		const access = await asStaff(
			call((p) => p.activityAccess()),
			{
				perms: permissions(true, seen),
			},
		);
		expect(access).toBe(true);
		expect(seen).toEqual([["audit", "read", { tenantId: 1 }]]);
		const result = await asStaff(
			call((p) => p.activityList()),
			{
				perms: permissions(true),
			},
		);
		expect(result.entries.map((e) => e.action)).toEqual(["feed.t1.second", "feed.t1.first"]);
		expect(result.total).toBe(2);
	});

	it("denies access and fails activityList Forbidden without the grant", async () => {
		await expect(
			asStaff(
				call((p) => p.activityAccess()),
				{ perms: permissions(false) },
			),
		).resolves.toBe(false);
		await expect(
			asStaff(
				call((p) => p.activityList()),
				{ perms: permissions(false) },
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "rbac.audit.read" });
	});

	it("fails closed when the Permissions service is absent", async () => {
		await expect(asStaff(call((p) => p.activityAccess()))).resolves.toBe(false);
		await expect(asStaff(call((p) => p.activityList()))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
	});

	it("fails closed without a resolvable tenant scope", async () => {
		const cases: Array<Tenant | null> = [
			null,
			{ id: "clinic-x", kind: "clinic", slug: "x", role: "admin" },
		];
		for (const t of cases) {
			await expect(
				asStaff(
					call((p) => p.activityAccess()),
					{ tenant: t, perms: permissions(true) },
				),
			).resolves.toBe(false);
			await expect(
				asStaff(
					call((p) => p.activityList()),
					{ tenant: t, perms: permissions(true) },
				),
			).rejects.toMatchObject({ _tag: "Forbidden" });
		}
	});
});

describe("AuditLive failure isolation", () => {
	it("record resolves even when the insert throws", async () => {
		const brokenDb = {
			insert: () => {
				throw new Error("db down");
			},
		} as unknown as DbClient;
		const deps = Layer.merge(
			Layer.succeed(Db, brokenDb),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(deps)));
		try {
			await runtime.runPromise(
				Effect.flatMap(Audit, (p) => p.record({ action: "a.b" })).pipe(
					Effect.provideService(Principal, { userId: "u1", email: "admin@x.com" }),
				),
			);
		} finally {
			await runtime.dispose();
		}
	});
});

describe("audit helper", () => {
	it("is a no-op when the Audit service is absent", async () => {
		await expect(Effect.runPromise(audit({ action: "a.b" }))).resolves.toBeUndefined();
	});

	it("delegates to the service when present", async () => {
		const seen: unknown[] = [];
		const stub = {
			record: (entry: never) => Effect.sync(() => seen.push(entry)),
			adminList: () => Effect.succeed({ entries: [], total: 0, limit: 200 }),
		} as unknown as Audit["Service"];
		await Effect.runPromise(
			audit({ action: "users.suspend", targetId: "u9" }).pipe(Effect.provideService(Audit, stub)),
		);
		expect(seen).toEqual([{ action: "users.suspend", targetId: "u9" }]);
	});
});

describe("plugins", () => {
	it("declares tables, services and panel as single-concern plugins", () => {
		expect(auditTablesPlugin.id).toBe("audit.tables");
		expect(auditTablesPlugin.tables).toBeDefined();
		expect(auditServicesPlugin.id).toBe("audit.services");
		expect(auditServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
		expect(auditServicesPlugin.services).toBeDefined();
		expect(auditChromePlugin.id).toBe("audit.chrome");
		expect(auditChromePlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(auditChromePlugin.chrome).toHaveLength(1);
		expect(auditChromePlugin.chrome?.[0]).toMatchObject({
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/audit", label: "Audit log", group: "Governance" },
			},
		});
		expect(auditPanelPlugin.id).toBe("audit.panel");
		expect(auditPanelPlugin.requiredDeps).toEqual(["platform.panel", "audit.services"]);
	});

	describe("panel page guard", () => {
		const guard = auditPanelPlugin.panel!.pages![0]!.guard as () => Effect.Effect<
			boolean,
			never,
			PlatformAdmin
		>;
		const gate = (admin: boolean) =>
			makePlatformAdminGate(parsePlatformAdminEmails(admin ? "admin@x.com" : ""));

		it("returns true for allowlisted admins", async () => {
			const result = await Effect.runPromise(
				guard().pipe(
					Effect.provideService(PlatformAdmin, gate(true)),
					Effect.provideService(Principal, { userId: "u1", email: "admin@x.com" }),
				),
			);
			expect(result).toBe(true);
		});

		it("returns false for non-admins", async () => {
			const result = await Effect.runPromise(
				guard().pipe(
					Effect.provideService(PlatformAdmin, gate(false)),
					Effect.provideService(Principal, { userId: "u1", email: "doc@x.com" }),
				),
			);
			expect(result).toBe(false);
		});
	});

	describe("panel page loader", () => {
		const loader = auditPanelPlugin.panel!.pages![0]!.loader as () => Effect.Effect<
			AuditListResult,
			never,
			Audit
		>;
		const stubAudit = (adminList: Audit["Service"]["adminList"]) =>
			({ adminList, record: () => Effect.void }) as unknown as Audit["Service"];

		it("returns the listing for admins", async () => {
			const result: AuditListResult = { entries: [], total: 0, limit: 200 };
			expect(
				await Effect.runPromise(
					loader().pipe(
						Effect.provideService(
							Audit,
							stubAudit(() => Effect.succeed(result)),
						),
					),
				),
			).toEqual(result);
		});

		it("collapses Forbidden to an empty page", async () => {
			expect(
				await Effect.runPromise(
					loader().pipe(
						Effect.provideService(
							Audit,
							stubAudit(() => Effect.fail(new Forbidden({ path: "platform.admin" }))),
						),
					),
				),
			).toEqual({ entries: [], total: 0, limit: 200 });
		});
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"audit.tables",
			"audit.services",
			"audit.chrome",
			"audit.panel",
		]);
	});
});

describe("adminAudit schema", () => {
	it("is registered in the composed drizzle schema", async () => {
		const { adminAudit: composed } = await import("@ktb/db/schema");
		expect(composed).toBe(adminAudit);
	});
});

describe("listPatientAuditEntries", () => {
	/** Seed one row per feed branch; returns the fresh db. */
	const seed = async () => {
		const d1 = makeD1(PATIENT_DDL);
		const fresh = makeDb(d1);
		const write = (
			action: string,
			targetType: string | null,
			targetId: string | number | null,
			detail?: Record<string, unknown> | null,
		) =>
			insertAuditEntry(fresh, {
				actorUserId: null,
				actorEmail: null,
				action,
				targetType,
				targetId,
				detail,
			});
		await write("patients.create", "patient", 5);
		await write("patients.update", "patient", "5");
		await write("patients.delete", "patient", 6);
		// Live consultation of patient 5 (consultations.id = 10).
		await write("consultations.save", "consultation", 10);
		// Live consultation of patient 6 — must not leak into patient 5.
		await write("consultations.anamnesis.attach", "consultation", 11);
		// Consultation already deleted: the join misses, detail.patientId catches.
		await write("consultations.delete", "consultation", 99, { hadAudio: true, patientId: 5 });
		await write("consultations.delete", "consultation", 98, { hadAudio: false });
		// Malformed JSON detail — json_extract yields NULL, no match.
		await fresh.insert(adminAudit).values({
			action: "consultations.delete",
			targetType: "consultation",
			targetId: "97",
			detail: "not-json{",
			createdAt: new Date(),
		});
		// Same targetId digits under another target type stay out.
		await write("users.suspend", "user", 5);
		await write("groups.update", "group", 5);
		return fresh;
	};

	it("returns patient-target rows plus the patient's consultation events only", async () => {
		const fresh = await seed();
		const result = await listPatientAuditEntries(fresh, 5);
		expect(result.entries.map((e) => e.action).sort()).toEqual([
			"consultations.delete",
			"consultations.save",
			"patients.create",
			"patients.update",
		]);
		expect(result.total).toBe(4);
		expect(result.limit).toBe(200);
	});

	it("matches nothing for a patient with no rows", async () => {
		const fresh = await seed();
		const result = await listPatientAuditEntries(fresh, 42);
		expect(result).toEqual({ entries: [], total: 0, limit: 200 });
	});

	it("clamps the page limit like the other listings", async () => {
		const fresh = await seed();
		expect((await listPatientAuditEntries(fresh, 5, { limit: 2 })).entries).toHaveLength(2);
		expect((await listPatientAuditEntries(fresh, 5, { limit: 0 })).entries).toHaveLength(1);
		expect((await listPatientAuditEntries(fresh, 5, { limit: 9999 })).limit).toBe(500);
	});

	it("reports a zero total when the count query yields no row", async () => {
		// Same thenable stub as the tenant listing, plus the `or`/`and`
		// scope both queries chain through.
		const query = {
			where: () => query,
			orderBy: () => ({ limit: async () => [] }),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
		};
		const fakeDb = { select: () => ({ from: () => query }) } as unknown as DbClient;
		const result = await listPatientAuditEntries(fakeDb, 5);
		expect(result).toEqual({ entries: [], total: 0, limit: 200 });
	});
});

describe("Audit patientList (P-086)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Audit, never>;

	beforeAll(async () => {
		const db = makeDb(makeD1(PATIENT_DDL));
		await insertAuditEntry(db, {
			actorUserId: null,
			actorEmail: null,
			action: "patients.update",
			targetType: "patient",
			targetId: 5,
		});
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const call = <A, E>(f: (p: Audit["Service"]) => Effect.Effect<A, E>) => Effect.flatMap(Audit, f);

	const access = (allowed: boolean, seen?: number[]) =>
		({
			canView: (patientId: number) => {
				seen?.push(patientId);
				return Effect.succeed(allowed);
			},
		}) as unknown as PatientAuditAccess["Service"];

	const asPatient = <A, E>(
		effect: Effect.Effect<A, E, Audit>,
		port?: PatientAuditAccess["Service"],
	) => {
		let eff = effect.pipe(Effect.provideService(Principal, { userId: "pat-1", email: "p@x.com" }));
		if (port !== undefined) eff = Effect.provideService(eff, PatientAuditAccess, port);
		return runtime.runPromise(eff);
	};

	it("fails closed when the PatientAuditAccess port is absent", async () => {
		await expect(asPatient(call((p) => p.patientList({ patientId: 5 })))).rejects.toMatchObject({
			_tag: "Forbidden",
			path: "audit.patient",
		});
	});

	it("fails Forbidden when canView denies the record", async () => {
		const seen: number[] = [];
		await expect(
			asPatient(
				call((p) => p.patientList({ patientId: 5 })),
				access(false, seen),
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "audit.patient" });
		expect(seen).toEqual([5]);
	});

	it("returns the patient-scoped feed when canView allows", async () => {
		const seen: number[] = [];
		const result = await asPatient(
			call((p) => p.patientList({ patientId: 5, limit: 10 })),
			access(true, seen),
		);
		expect(seen).toEqual([5]);
		expect(result.entries.map((e) => e.action)).toEqual(["patients.update"]);
		expect(result.limit).toBe(10);
	});
});
