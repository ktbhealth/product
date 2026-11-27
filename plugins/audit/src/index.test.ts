import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import { DoctorProfiles, type DoctorProfile } from "@ktb/server-fns";
import { Forbidden, Principal } from "@ktb/authz";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";

import { eq } from "drizzle-orm";

import { adminAudit } from "./schema.ts";
import {
	Audit,
	AuditLive,
	audit,
	auditChromePlugin,
	auditEntryHash,
	auditPanelPlugin,
	auditServicesPlugin,
	auditTablesPlugin,
	hasRecentAuditRead,
	insertAuditEntry,
	auditListFacets,
	listActorAuditEntries,
	listAuditEntries,
	sanitizeAuditDetail,
	listPatientAuditEntries,
	listTenantAuditEntries,
	PatientAuditAccess,
	plugins,
	verifyAuditChain,
	type AuditListResult,
} from "./index.ts";

const DDL = `
INSERT INTO groups (name, slug, kind, meta, created_at, updated_at) VALUES ('Clinic A', 'clinic-a', 'clinic', NULL, 1000, 1000);
`;

const PATIENT_DDL = `
INSERT INTO groups (name, slug, kind, meta, created_at, updated_at) VALUES ('Clinic A', 'clinic-a', 'clinic', NULL, 1000, 1000);
INSERT INTO consultations (id, patient_id, transcript, created_at) VALUES (10, 5, '', 0), (11, 6, '', 0), (12, NULL, '', 0);
`;

describe("audit repo", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeTestD1(DDL));
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
		// D1: strings cap at 200 chars inside the sanitizer, so a single
		// blob can no longer reach the 4000-char JSON cap — pad with
		// many keys to still exercise DETAIL_MAX.
		const wide: Record<string, string> = {};
		for (let i = 0; i < 30; i++) wide[`k${i}`] = "x".repeat(200);
		const big = await insertAuditEntry(db, {
			actorUserId: null,
			actorEmail: null,
			action: "a.b",
			detail: wide,
		});
		expect(big!.detail!.length).toBe(4000);
		const cappedString = await insertAuditEntry(db, {
			actorUserId: null,
			actorEmail: null,
			action: "a.b",
			detail: { blob: "x".repeat(5000) },
		});
		expect(JSON.parse(cappedString!.detail!)).toEqual({ blob: "x".repeat(200) });
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
		const fresh = makeDb(makeTestD1(DDL));
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
		const fresh = makeDb(makeTestD1(DDL));
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
			where: () => query,
			orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
		};
		const fakeDb = { select: () => ({ from: () => query }) } as unknown as DbClient;
		const result = await listAuditEntries(fakeDb);
		expect(result).toEqual({ entries: [], total: 0, limit: 200, offset: 0 });
	});
});

describe("listTenantAuditEntries", () => {
	it("returns only the tenant's rows, newest-first — NULL tenant excluded", async () => {
		const fresh = makeDb(makeTestD1(DDL));
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
		const fresh = makeDb(makeTestD1(DDL));
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
			orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
		};
		const fakeDb = { select: () => ({ from: () => query }) } as unknown as DbClient;
		const result = await listTenantAuditEntries(fakeDb, 1);
		expect(result).toEqual({ entries: [], total: 0, limit: 200, offset: 0 });
	});
});

describe("listActorAuditEntries", () => {
	it("returns rows matching any actor's userId or email — system rows excluded", async () => {
		const fresh = makeDb(makeTestD1(DDL));
		const write = (action: string, actorUserId: string | null, actorEmail: string | null) =>
			insertAuditEntry(fresh, { action, actorUserId, actorEmail });
		await write("feed.self", "sec-1", "sec@x.com");
		await write("feed.doctor", "doc-1", "doc@x.com");
		await write("feed.email-only", "other-id", "doc@x.com");
		await write("feed.other", "doc-2", "other@x.com");
		await write("feed.system", null, null);
		const result = await listActorAuditEntries(fresh, [
			{ userId: "sec-1", email: "sec@x.com" },
			{ userId: "doc-1", email: "doc@x.com" },
		]);
		expect(result.entries.map((e) => e.action)).toEqual([
			"feed.email-only",
			"feed.doctor",
			"feed.self",
		]);
		expect(result.total).toBe(3);
	});

	it("matches by userId alone when actors carry no email", async () => {
		const fresh = makeDb(makeTestD1(DDL));
		await insertAuditEntry(fresh, {
			action: "feed.self",
			actorUserId: "sec-1",
			actorEmail: "sec@x.com",
		});
		await insertAuditEntry(fresh, {
			action: "feed.other",
			actorUserId: "doc-2",
			actorEmail: "other@x.com",
		});
		const result = await listActorAuditEntries(fresh, [{ userId: "sec-1", email: null }]);
		expect(result.entries.map((e) => e.action)).toEqual(["feed.self"]);
		expect(result.total).toBe(1);
	});

	it("returns an empty page for an empty actor set", async () => {
		const fresh = makeDb(makeTestD1(DDL));
		await insertAuditEntry(fresh, {
			action: "feed.self",
			actorUserId: "sec-1",
			actorEmail: null,
		});
		expect(await listActorAuditEntries(fresh, [])).toEqual({
			entries: [],
			total: 0,
			limit: 200,
			offset: 0,
		});
	});

	it("reports a zero total when the count query yields no row", async () => {
		const query = {
			where: () => query,
			orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
		};
		const fakeDb = { select: () => ({ from: () => query }) } as unknown as DbClient;
		const result = await listActorAuditEntries(fakeDb, [{ userId: "u", email: null }]);
		expect(result).toEqual({ entries: [], total: 0, limit: 200, offset: 0 });
	});
});

describe("audit chain (T-139)", () => {
	let db: ReturnType<typeof makeDb>;

	beforeAll(() => {
		db = makeDb(makeTestD1(DDL));
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
		const empty = makeDb(makeTestD1(DDL));
		expect(await verifyAuditChain(empty)).toEqual({
			status: "empty",
			entries: 0,
			brokenAt: null,
		});
	});

	it("accepts an unchained legacy prefix (pre-column rows)", async () => {
		const legacy = makeDb(makeTestD1(DDL));
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
		const tampered = makeDb(makeTestD1(DDL));
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
		const tampered = makeDb(makeTestD1(DDL));
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
		const tampered = makeDb(makeTestD1(DDL));
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
		const tampered = makeDb(makeTestD1(DDL));
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
		const db = makeDb(makeTestD1(DDL));
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

	it("adminFacets returns the log's distinct filter values, admins only", async () => {
		const facets = await asUser(
			"admin-1",
			call((p) => p.adminFacets()),
			"admin@x.com",
		);
		// Rows recorded by earlier tests in this describe.
		expect(facets.actionGroups).toEqual(expect.arrayContaining(["delegated", "groups", "system"]));
		expect(facets.actors).toContain("admin@x.com");
		await expect(
			asUser(
				"u2",
				call((p) => p.adminFacets()),
				"doc@x.com",
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});
});

describe("Audit activity feed — actor scope", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Audit, never>;
	let db: DbClient;

	beforeAll(async () => {
		db = makeDb(makeTestD1(DDL));
		const write = (action: string, actorUserId: string | null, actorEmail: string | null) =>
			insertAuditEntry(db, { action, actorUserId, actorEmail });
		await write("feed.self.one", "sec-1", "sec@x.com");
		await write("feed.self.two", "sec-1", "sec@x.com");
		await write("feed.doctor", "doc-1", "doc@x.com");
		await write("feed.other", "doc-2", "other@x.com");
		await write("feed.system", null, null);
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(deps)));
	});

	afterAll(() => runtime.dispose());

	const call = <A, E>(f: (p: Audit["Service"]) => Effect.Effect<A, E>) => Effect.flatMap(Audit, f);

	/** Stub DoctorProfiles directory: `profiles` is what listFor
	 * returns for ANY account id; absent means the doctors plugin is
	 * not deployed (serviceOption → None). */
	const directory = (profiles?: readonly DoctorProfile[]) =>
		profiles === undefined
			? undefined
			: ({
					listFor: () => Effect.succeed(profiles),
					claimInvites: () => Effect.succeed(0),
				} as unknown as DoctorProfiles["Service"]);

	const DELEGATED: readonly DoctorProfile[] = [
		{
			doctorId: 7,
			userId: "doc-1",
			email: "doc@x.com",
			displayName: "Dr. One",
			role: "secretary",
		},
	];

	/** Run under a staff principal; `actorId` simulates a secretary
	 * acting on a doctor's behalf (the account is `actorId`). */
	const asStaff = <A, E>(
		effect: Effect.Effect<A, E, Audit>,
		opts: {
			principal?: { userId: string; email?: string; actorId?: string } | null;
			profiles?: readonly DoctorProfile[];
		} = {},
	) => {
		let eff = effect.pipe(
			Effect.provideService(
				Principal,
				opts.principal === undefined ? { userId: "sec-1", email: "sec@x.com" } : opts.principal,
			),
		);
		const dir = directory(opts.profiles);
		if (dir !== undefined) eff = Effect.provideService(eff, DoctorProfiles, dir);
		return runtime.runPromise(eff);
	};

	it("activityAccess is true for any signed-in principal", async () => {
		await expect(asStaff(call((p) => p.activityAccess()))).resolves.toBe(true);
		await expect(
			asStaff(
				call((p) => p.activityAccess()),
				{
					principal: { userId: "doc-9", actorId: "sec-1", email: "sec@x.com" },
				},
			),
		).resolves.toBe(true);
	});

	it("activityList returns self plus delegated-doctor rows only", async () => {
		const result = await asStaff(
			call((p) => p.activityList()),
			{ profiles: DELEGATED },
		);
		expect(result.entries.map((e) => e.action)).toEqual([
			"feed.doctor",
			"feed.self.two",
			"feed.self.one",
		]);
		expect(result.total).toBe(3);
	});

	it("scopes to self only without the DoctorProfiles service", async () => {
		const result = await asStaff(call((p) => p.activityList()));
		expect(result.entries.map((e) => e.action)).toEqual(["feed.self.two", "feed.self.one"]);
		expect(result.total).toBe(2);
	});

	it("scopes to self only when the directory fails or lists nothing", async () => {
		const failing = {
			listFor: () => Effect.fail(new Error("directory down")),
			claimInvites: () => Effect.succeed(0),
		} as unknown as DoctorProfiles["Service"];
		const result = await runtime.runPromise(
			call((p) => p.activityList()).pipe(
				Effect.provideService(Principal, { userId: "sec-1", email: "sec@x.com" }),
				Effect.provideService(DoctorProfiles, failing),
			),
		);
		expect(result.entries.map((e) => e.action)).toEqual(["feed.self.two", "feed.self.one"]);
		const empty = await asStaff(
			call((p) => p.activityList()),
			{ profiles: [] },
		);
		expect(empty.entries.map((e) => e.action)).toEqual(["feed.self.two", "feed.self.one"]);
	});

	it("attributes delegated actions to the signed-in account, not the acted doctor", async () => {
		// Secretary acting as doc-1: actorId is the account — the feed
		// still keys on sec-1, never on the acting profile's userId.
		const result = await asStaff(
			call((p) => p.activityList()),
			{
				principal: { userId: "doc-1", actorId: "sec-1", email: "sec@x.com" },
				profiles: DELEGATED,
			},
		);
		expect(result.entries.map((e) => e.action)).toEqual([
			"feed.doctor",
			"feed.self.two",
			"feed.self.one",
		]);
	});

	it("the actor filter narrows within the visible scope", async () => {
		const result = await asStaff(
			call((p) => p.activityList({ actor: "doc@x.com" })),
			{
				profiles: DELEGATED,
			},
		);
		expect(result.entries.map((e) => e.action)).toEqual(["feed.doctor"]);
		// An actor outside the scope matches nothing — the fence wins
		// over the filter, it cannot widen it.
		const denied = await asStaff(
			call((p) => p.activityList({ actor: "other@x.com" })),
			{
				profiles: DELEGATED,
			},
		);
		expect(denied.entries).toEqual([]);
		expect(denied.total).toBe(0);
	});

	it("fails closed without a principal", async () => {
		await expect(
			asStaff(
				call((p) => p.activityAccess()),
				{ principal: null },
			),
		).resolves.toBe(false);
		await expect(
			asStaff(
				call((p) => p.activityList()),
				{ principal: null },
			),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "audit.activity" });
		await expect(
			asStaff(
				call((p) => p.activityFacets()),
				{ principal: null },
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("dedupes the account against directory profiles and normalizes empty emails", async () => {
		// Email-less principal: exercises the `email ?? null` account
		// fallback. A profile repeating the account's userId is skipped
		// (the secretary IS the account); a profile with an empty email
		// normalizes to null so it can't match rows by "".
		const result = await asStaff(
			call((p) => p.activityList()),
			{
				principal: { userId: "sec-1" },
				profiles: [
					{
						doctorId: 1,
						userId: "sec-1",
						email: "sec@x.com",
						displayName: "Self",
						role: "secretary",
					},
					{
						doctorId: 2,
						userId: "doc-9",
						email: "",
						displayName: "No Mail",
						role: "secretary",
					},
				],
			},
		);
		expect(result.entries.map((e) => e.action)).toEqual(["feed.self.two", "feed.self.one"]);
		expect(result.total).toBe(2);
	});

	it("activityFacets unions email-less actors by userId", async () => {
		const facets = await asStaff(
			call((p) => p.activityFacets()),
			{
				principal: { userId: "sec-1" },
			},
		);
		// Self has no email → the permitted key falls back to userId;
		// doc@x.com stays out of scope without the directory.
		expect(facets.actors).toEqual(["sec-1", "sec@x.com"]);
	});

	it("activityFacets scopes dropdowns to the actor feed and unions permitted actors", async () => {
		const facets = await asStaff(
			call((p) => p.activityFacets()),
			{ profiles: DELEGATED },
		);
		expect(facets.actionGroups).toEqual(["feed"]);
		// Actors with entries (doc@x.com, sec@x.com) — the permitted
		// actor keys union in, and other@x.com never leaks.
		expect(facets.actors).toEqual(["doc@x.com", "sec@x.com"]);
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
			adminList: () => Effect.succeed({ entries: [], total: 0, limit: 200, offset: 0 }),
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
				item: { to: "/platform/audit", label: "Audit log", group: "Assurance" },
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
			const result: AuditListResult = { entries: [], total: 0, limit: 200, offset: 0 };
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
			).toEqual({ entries: [], total: 0, limit: 200, offset: 0 });
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
		const d1 = makeTestD1(PATIENT_DDL);
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
		expect(result).toEqual({ entries: [], total: 0, limit: 200, offset: 0 });
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
			orderBy: () => ({ limit: () => ({ offset: async () => [] }) }),
			then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
		};
		const fakeDb = { select: () => ({ from: () => query }) } as unknown as DbClient;
		const result = await listPatientAuditEntries(fakeDb, 5);
		expect(result).toEqual({ entries: [], total: 0, limit: 200, offset: 0 });
	});
});

describe("Audit patientList (P-086)", () => {
	let runtime: ManagedRuntime.ManagedRuntime<Audit, never>;

	beforeAll(async () => {
		const db = makeDb(makeTestD1(PATIENT_DDL));
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

	it("patientFacets applies the same access gate and patient scope", async () => {
		await expect(asPatient(call((p) => p.patientFacets({ patientId: 5 })))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(
			asPatient(
				call((p) => p.patientFacets({ patientId: 5 })),
				access(false),
			),
		).rejects.toMatchObject({ _tag: "Forbidden" });
		const facets = await asPatient(
			call((p) => p.patientFacets({ patientId: 5 })),
			access(true),
		);
		expect(facets.actionGroups).toEqual(["patients"]);
		expect(facets.targetTypes).toEqual(["patient"]);
	});
});

describe("sanitizeAuditDetail (P-087 D1)", () => {
	it("drops blocklisted keys at any depth and keeps legit ids/flags", () => {
		const clean = sanitizeAuditDetail({
			patientId: 5,
			ownerId: "u1",
			hadAudio: true,
			engine: "whisper",
			via: "portal",
			status: "done",
			source: "mic",
			backfilled: 2,
			remaining: 0,
			patientName: "Maria",
			nested: { email: "a@b.c", cpf: "123", ok: 1 },
			list: [{ phone: "999", note: "x" }, { fine: true }],
		});
		expect(clean).toEqual({
			patientId: 5,
			ownerId: "u1",
			hadAudio: true,
			engine: "whisper",
			via: "portal",
			status: "done",
			source: "mic",
			backfilled: 2,
			remaining: 0,
			nested: { ok: 1 },
			list: [{}, { fine: true }],
		});
	});

	it("matches the blocklist case-insensitively as a substring (camelCase)", () => {
		const clean = sanitizeAuditDetail({
			FileName: "a.pdf",
			APIKey: "k",
			DEK: "d",
			patientEMAIL: "x",
			transcriptText: "t",
			ok: 1,
		});
		expect(clean).toEqual({ ok: 1 });
	});

	it("caps nesting depth, array length and string length", () => {
		// root(0) → l1(1) → l2(2) → l3(3) → l4(4 = dropped)
		expect(sanitizeAuditDetail({ l1: { l2: { l3: { l4: { l5: "x" } } } } })).toEqual({
			l1: { l2: { l3: {} } },
		});
		const many = Array.from({ length: 25 }, (_, i) => i);
		expect(sanitizeAuditDetail({ arr: many })).toEqual({ arr: many.slice(0, 20) });
		expect(sanitizeAuditDetail({ s: "y".repeat(500) })).toEqual({ s: "y".repeat(200) });
	});

	it("coerces/drops non-JSON-safe values without throwing", () => {
		const circular: Record<string, unknown> = { ok: 1 };
		circular.self = circular;
		const clean = sanitizeAuditDetail({
			big: BigInt(10),
			nan: Number.NaN,
			inf: Number.POSITIVE_INFINITY,
			nothing: undefined,
			fn: () => 1,
			sym: Symbol("s"),
			when: new Date(0),
			circular,
			// Array items that sanitize to the drop sentinel are skipped.
			arr: [undefined, () => 1, Symbol("s"), "kept"],
		});
		expect(clean).toEqual({
			big: "10",
			nan: null,
			inf: null,
			when: "1970-01-01T00:00:00.000Z",
			circular: { ok: 1 },
			arr: ["kept"],
		});
	});

	it("returns null when nothing survives sanitization", () => {
		expect(sanitizeAuditDetail(null)).toBeNull();
		expect(sanitizeAuditDetail(undefined)).toBeNull();
		expect(sanitizeAuditDetail({})).toBeNull();
		expect(sanitizeAuditDetail({ patientName: "x", email: "y" })).toBeNull();
	});

	it("returns null when the sanitized value is not a plain record", () => {
		// Top-level arrays/scalars (cast past the Record type) sanitize
		// to non-records; toJSON can also collapse the payload to a
		// scalar, null, an array or the drop sentinel — all record NULL.
		expect(sanitizeAuditDetail([] as unknown as Record<string, unknown>)).toBeNull();
		expect(sanitizeAuditDetail("raw" as unknown as Record<string, unknown>)).toBeNull();
		expect(sanitizeAuditDetail(new Date(0) as unknown as Record<string, unknown>)).toBeNull();
		expect(sanitizeAuditDetail({ toJSON: () => null })).toBeNull();
		expect(sanitizeAuditDetail({ toJSON: () => ["a"] })).toBeNull();
		expect(sanitizeAuditDetail({ toJSON: () => undefined })).toBeNull();
	});

	it("insertAuditEntry stores the sanitized detail JSON", async () => {
		const db = makeDb(makeTestD1(DDL));
		const row = await insertAuditEntry(db, {
			actorUserId: null,
			actorEmail: null,
			action: "sanitize.check",
			detail: { patientId: 5, patientName: "X", nested: { secret: "s", flag: true } },
		});
		expect(JSON.parse(row!.detail!)).toEqual({
			patientId: 5,
			nested: { flag: true },
		});
	});
});

describe("hasRecentAuditRead (P-087 D3)", () => {
	it("matches NULL columns via IS NULL and respects the window", async () => {
		const db = makeDb(makeTestD1(DDL));
		await insertAuditEntry(db, {
			actorUserId: null,
			actorEmail: null,
			action: "probe.read",
			targetType: "patient",
			targetId: 5,
		});
		const key = {
			actorUserId: null,
			action: "probe.read",
			targetType: "patient",
			targetId: "5",
		};
		await expect(hasRecentAuditRead(db, key, 60000)).resolves.toBe(true);
		// A different (non-null) actor must NOT match the null-actor row.
		await expect(hasRecentAuditRead(db, { ...key, actorUserId: "u1" }, 60000)).resolves.toBe(false);
		// Outside the window nothing matches.
		await expect(hasRecentAuditRead(db, key, -1)).resolves.toBe(false);
	});
});

describe("Audit record coalescing + runtime config (P-087 D3/D5)", () => {
	// PluginStates is resolved per record() call from the CALLER's
	// context (serviceOption) — provide it on the effect, not the layer.
	const depsFor = (db: DbClient) =>
		Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);

	const statesStub = (config: unknown) =>
		({ config: () => Effect.succeed(config) }) as unknown as PluginStates["Service"];

	const record = (
		runtime: ManagedRuntime.ManagedRuntime<Audit, never>,
		entry: Parameters<Audit["Service"]["record"]>[0],
		principal: { userId: string; email?: string } | null = { userId: "u1", email: "u@x.com" },
		states?: unknown,
	) => {
		let eff = Effect.flatMap(Audit, (p) => p.record(entry)).pipe(
			Effect.provideService(Principal, principal),
		);
		if (states !== undefined) {
			eff = Effect.provideService(eff, PluginStates, states as PluginStates["Service"]);
		}
		return runtime.runPromise(eff);
	};

	const actions = async (db: DbClient) => (await db.select().from(adminAudit)).map((r) => r.action);

	it("coalesces an identical .read within the window; mutations never coalesce", async () => {
		const db = makeDb(makeTestD1(DDL));
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			const read = { action: "patients.read", targetType: "patient", targetId: 5 };
			await record(runtime, read);
			await record(runtime, read);
			// Same action, different target → not coalesced.
			await record(runtime, { ...read, targetId: 6 });
			// Same target, different actor → not coalesced.
			await record(runtime, read, { userId: "u2", email: "v@x.com" });
			// Different action suffix → not coalesced.
			await record(runtime, {
				action: "patients.history.read",
				targetType: "patient",
				targetId: 5,
			});
			// Mutation actions are never coalesced.
			await record(runtime, { action: "patients.update", targetType: "patient", targetId: 5 });
			await record(runtime, { action: "patients.update", targetType: "patient", targetId: 5 });
			const rows = await db.select().from(adminAudit);
			expect(rows.filter((r) => r.action === "patients.read")).toHaveLength(3);
			expect(rows.filter((r) => r.action === "patients.history.read")).toHaveLength(1);
			expect(rows.filter((r) => r.action === "patients.update")).toHaveLength(2);
		} finally {
			await runtime.dispose();
		}
	});

	it("coalesces NULL-actor reads via IS NULL, distinct from user reads", async () => {
		const db = makeDb(makeTestD1(DDL));
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			const read = { action: "system.read", targetType: "report", targetId: "r1" };
			await record(runtime, read, null);
			await record(runtime, read, null);
			await record(runtime, read, { userId: "u1" });
			const rows = (await db.select().from(adminAudit)).filter((r) => r.action === "system.read");
			expect(rows).toHaveLength(2);
			expect(rows.filter((r) => r.actorUserId === null)).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});

	it("coalesces reads with absent target fields via the NULL-key probe", async () => {
		const db = makeDb(makeTestD1(DDL));
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			// No targetType/targetId → the dedupe probe compares NULL
			// columns with IS NULL; identical reads still coalesce.
			const read = { action: "feed.read" };
			await record(runtime, read);
			await record(runtime, read);
			// Explicit nulls take the same path.
			await record(runtime, { action: "feed.read", targetType: null, targetId: null });
			expect(
				(await db.select().from(adminAudit)).filter((r) => r.action === "feed.read"),
			).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});

	it("inserts again once the coalescing window has expired", async () => {
		const db = makeDb(makeTestD1(DDL));
		// Seed a read older than the default 60s window directly.
		await db.insert(adminAudit).values({
			action: "patients.read",
			actorUserId: "u1",
			targetType: "patient",
			targetId: "5",
			createdAt: new Date(Date.now() - 120_000),
		});
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			await record(runtime, {
				action: "patients.read",
				targetType: "patient",
				targetId: 5,
			});
			expect(
				(await db.select().from(adminAudit)).filter((r) => r.action === "patients.read"),
			).toHaveLength(2);
		} finally {
			await runtime.dispose();
		}
	});

	it("readCoalesceMs=0 disables coalescing; partial stored config keeps defaults", async () => {
		const db = makeDb(makeTestD1(DDL));
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			const read = { action: "patients.read", targetType: "patient", targetId: 5 };
			const states = statesStub({ readCoalesceMs: 0 });
			await record(runtime, read, undefined, states);
			await record(runtime, read, undefined, states);
			expect(
				(await db.select().from(adminAudit)).filter((r) => r.action === "patients.read"),
			).toHaveLength(2);
		} finally {
			await runtime.dispose();
		}
	});

	it("readsEnabled=false drops *.read events but mutations still record", async () => {
		const db = makeDb(makeTestD1(DDL));
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			const states = statesStub({ readsEnabled: false });
			await record(
				runtime,
				{ action: "patients.read", targetType: "patient", targetId: 5 },
				undefined,
				states,
			);
			await record(
				runtime,
				{ action: "patients.update", targetType: "patient", targetId: 5 },
				undefined,
				states,
			);
			expect(await actions(db)).toEqual(["patients.update"]);
		} finally {
			await runtime.dispose();
		}
	});

	it("enabled=false is the global kill switch", async () => {
		const db = makeDb(makeTestD1(DDL));
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			const states = statesStub({ enabled: false });
			await record(
				runtime,
				{ action: "patients.read", targetType: "patient", targetId: 5 },
				undefined,
				states,
			);
			await record(
				runtime,
				{ action: "patients.update", targetType: "patient", targetId: 5 },
				undefined,
				states,
			);
			expect(await actions(db)).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	it("corrupt stored config falls back to defaults (coalescing still applies)", async () => {
		const db = makeDb(makeTestD1(DDL));
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			const read = { action: "patients.read", targetType: "patient", targetId: 5 };
			const states = statesStub("not-an-object");
			await record(runtime, read, undefined, states);
			await record(runtime, read, undefined, states);
			expect(
				(await db.select().from(adminAudit)).filter((r) => r.action === "patients.read"),
			).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});

	it("falls back to defaults when the PluginStates config read itself fails", async () => {
		const db = makeDb(makeTestD1(DDL));
		const runtime = ManagedRuntime.make(AuditLive.pipe(Layer.provide(depsFor(db))));
		try {
			// config() failing (typed error — Effect.catch only handles
			// failures, not defects) must not break record(): the write
			// proceeds under DEFAULT_AUDIT_CONFIG.
			const states = {
				config: () => Effect.fail(new Error("state store down")),
			} as unknown as PluginStates["Service"];
			const read = { action: "patients.read", targetType: "patient", targetId: 5 };
			await record(runtime, read, undefined, states);
			await record(runtime, read, undefined, states);
			// Defaults apply: readsEnabled + 60s coalescing window.
			expect(
				(await db.select().from(adminAudit)).filter((r) => r.action === "patients.read"),
			).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});
});

describe("audit list filters and facets", () => {
	const seed = async () => {
		const db = makeDb(makeTestD1(DDL));
		const write = (over: Parameters<typeof insertAuditEntry>[1]) => insertAuditEntry(db, over);
		await write({
			action: "users.suspend",
			actorUserId: "u1",
			actorEmail: "admin@x.com",
			targetType: "user",
			targetId: "9",
			tenantId: 1,
		});
		await write({
			action: "users.invite",
			actorUserId: "u2",
			actorEmail: null,
			targetType: "user",
			targetId: "8",
			tenantId: 1,
		});
		await write({
			action: "patients.read",
			actorUserId: "u3",
			actorEmail: "doc@x.com",
			targetType: "patient",
			targetId: "5",
			detail: { refId: "needle-value" },
			tenantId: 2,
		});
		await write({ action: "system.ping", actorUserId: null, actorEmail: null });
		return db;
	};

	it("filters by action group (first dot segment)", async () => {
		const db = await seed();
		const result = await listAuditEntries(db, { actionGroup: "users" });
		expect(result.entries.map((e) => e.action).sort()).toEqual(["users.invite", "users.suspend"]);
		expect(result.total).toBe(2);
	});

	it("strips LIKE metacharacters from the action group", async () => {
		const db = await seed();
		// "users%" would wildcard-match everything unescaped; stripped
		// to "users" it still scopes to the group.
		expect((await listAuditEntries(db, { actionGroup: "users%" })).total).toBe(2);
		// A group that strips to empty adds no condition at all.
		expect((await listAuditEntries(db, { actionGroup: "%" })).total).toBe(4);
	});

	it("filters by actor — email, user-id fallback and the NULL bucket", async () => {
		const db = await seed();
		expect((await listAuditEntries(db, { actor: "admin@x.com" })).entries[0]?.action).toBe(
			"users.suspend",
		);
		// Email NULL + user id match — the view's actorKey fallback.
		expect((await listAuditEntries(db, { actor: "u2" })).entries[0]?.action).toBe("users.invite");
		// Explicit null selects rows with neither email nor user id.
		const system = await listAuditEntries(db, { actor: null });
		expect(system.entries.map((e) => e.action)).toEqual(["system.ping"]);
		expect((await listAuditEntries(db, { actor: "nobody" })).total).toBe(0);
	});

	it("filters by target type, including the NULL bucket", async () => {
		const db = await seed();
		expect((await listAuditEntries(db, { targetType: "user" })).total).toBe(2);
		const none = await listAuditEntries(db, { targetType: null });
		expect(none.entries.map((e) => e.action)).toEqual(["system.ping"]);
	});

	it("filters by free-text q across actor, action, target and detail", async () => {
		const db = await seed();
		expect((await listAuditEntries(db, { q: "needle-value" })).entries[0]?.action).toBe(
			"patients.read",
		);
		// LIKE is case-insensitive for ASCII — "ADMIN" finds admin@x.com.
		expect((await listAuditEntries(db, { q: "ADMIN" })).entries[0]?.action).toBe("users.suspend");
		expect((await listAuditEntries(db, { q: "patient" })).total).toBe(1);
		// Null/blank q adds no condition.
		expect((await listAuditEntries(db, { q: null })).total).toBe(4);
		expect((await listAuditEntries(db, { q: "   " })).total).toBe(4);
	});

	it("filters by since/until epoch bounds", async () => {
		const db = await seed();
		const now = Date.now();
		expect((await listAuditEntries(db, { since: now + 60_000 })).total).toBe(0);
		expect((await listAuditEntries(db, { until: now - 60_000 })).total).toBe(0);
		expect((await listAuditEntries(db, { since: 0, until: now + 60_000 })).total).toBe(4);
		// Non-finite bounds are ignored rather than poisoning the query.
		expect((await listAuditEntries(db, { since: Number.NaN })).total).toBe(4);
	});

	it("paginates with offset and reports the resolved offset", async () => {
		const db = await seed();
		const page = await listAuditEntries(db, { limit: 2, offset: 2 });
		expect(page.entries).toHaveLength(2);
		expect(page.offset).toBe(2);
		expect(page.total).toBe(4);
		// Negative/NaN offsets clamp to the first page.
		expect((await listAuditEntries(db, { offset: -5 })).offset).toBe(0);
		expect((await listAuditEntries(db, { offset: Number.NaN })).offset).toBe(0);
	});

	it("auditListFacets returns the distinct filter values in scope", async () => {
		const db = await seed();
		// A dotless action groups under itself — covers the no-dot split.
		await db.insert(adminAudit).values({
			action: "flat",
			createdAt: new Date(),
		});
		const facets = await auditListFacets(db);
		expect(facets.actionGroups).toEqual(["flat", "patients", "system", "users"]);
		expect(facets.actors).toHaveLength(4);
		expect(facets.actors).toContain("admin@x.com");
		expect(facets.actors).toContain("u2");
		expect(facets.actors).toContain(null);
		expect(facets.targetTypes).toHaveLength(3);
		expect(facets.targetTypes).toContain("user");
		expect(facets.targetTypes).toContain(null);
	});
});
