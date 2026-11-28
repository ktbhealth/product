import { eq } from "drizzle-orm";
import { integer, SQLiteSyncDialect, text } from "drizzle-orm/sqlite-core";
import * as Effect from "effect/Effect";
import { Tracer } from "effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient, type SqlDatabase } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { Tenant, withTenantAccess } from "./index.ts";
import {
	accessibleTenantIds,
	scopedRepo,
	tenantIdAccessible,
	tenantRowScope,
	tenantScopeCondition,
	type ScopedRepo,
} from "./scoped-repo.ts";
import { tenantIdColumn, tenantTable } from "./schema.ts";

const notes = tenantTable("test_notes", {
	id: integer().primaryKey({ autoIncrement: true }),
	tenantId: tenantIdColumn(),
	body: text().notNull(),
});

const owned = tenantTable("test_owned", {
	id: integer().primaryKey({ autoIncrement: true }),
	tenantId: tenantIdColumn(),
	ownerId: text("owner_id"),
	body: text().notNull(),
});

const DDL = `
CREATE TABLE test_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, body TEXT NOT NULL);
CREATE TABLE test_owned (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, owner_id TEXT, body TEXT NOT NULL);
`;

const tenantA: Tenant = { id: 1, kind: "clinic", slug: "a", role: "member" };
const tenantB: Tenant = { id: 2, kind: "clinic", slug: "b", role: "member" };

interface Fixture {
	readonly sql: SqlDatabase;
	readonly db: DbClient;
	readonly live: Layer.Layer<Db>;
	readonly ids: { a1: number; a2: number; b1: number; p1: number };
}

const makeFixture = async (): Promise<Fixture> => {
	const sql = makeTestD1(DDL);
	const ins = (tenantId: number | null, body: string) =>
		sql
			.prepare("INSERT INTO test_notes (tenant_id, body) VALUES (?, ?)")
			.bind(tenantId, body)
			.run();
	await ins(1, "a1");
	await ins(1, "a2");
	await ins(2, "b1");
	await ins(null, "p1");
	const rows = await sql
		.prepare("SELECT id, tenant_id, body FROM test_notes ORDER BY id")
		.all<{ id: number; tenant_id: number | null; body: string }>();
	const byBody = new Map(rows.results.map((r) => [r.body, r.id]));
	const db = makeDb(sql);
	return {
		sql,
		db,
		live: Layer.succeed(Db, db),
		ids: {
			a1: byBody.get("a1")!,
			a2: byBody.get("a2")!,
			b1: byBody.get("b1")!,
			p1: byBody.get("p1")!,
		},
	};
};

const withTenant = <A, E>(
	tenant: Tenant | null,
	effect: Effect.Effect<A, E, Db>,
	live: Layer.Layer<Db>,
) => Effect.runPromise(effect.pipe(Effect.provide(live), Effect.provideService(Tenant, tenant)));

const repo = <A, E>(
	f: Fixture,
	tenant: Tenant | null,
	fn: (r: ScopedRepo<typeof notes>) => Effect.Effect<A, E, never>,
) => withTenant(tenant, scopedRepo(notes).pipe(Effect.flatMap(fn)), f.live);

describe("accessibleTenantIds", () => {
	it("derives the active tenant's id", async () => {
		await expect(
			Effect.runPromise(Effect.provideService(accessibleTenantIds, Tenant, tenantA)),
		).resolves.toEqual([1]);
	});

	it("is empty in personal scope", async () => {
		await expect(Effect.runPromise(accessibleTenantIds)).resolves.toEqual([]);
	});

	it("prefers an explicit TenantAccess set", async () => {
		await expect(
			Effect.runPromise(
				withTenantAccess([4, 5], accessibleTenantIds).pipe(Effect.provideService(Tenant, tenantA)),
			),
		).resolves.toEqual([4, 5]);
	});
});

describe("tenantScopeCondition", () => {
	it("produces a SQL condition for any scope", async () => {
		const condition = await Effect.runPromise(
			tenantScopeCondition(notes).pipe(Effect.provideService(Tenant, tenantA)),
		);
		expect(condition).toBeDefined();
	});

	it("degrades to a bare IS NULL in personal scope", async () => {
		const condition = await Effect.runPromise(tenantScopeCondition(notes));
		const { sql } = new SQLiteSyncDialect().sqlToQuery(condition!);
		expect(sql).toBe('"test_notes"."tenant_id" is null');
	});

	it("scopes to the accessible ids OR personal rows", async () => {
		const condition = await Effect.runPromise(
			withTenantAccess([1, 2], tenantScopeCondition(notes)),
		);
		const { sql, params } = new SQLiteSyncDialect().sqlToQuery(condition!);
		expect(sql).toContain(" in ");
		expect(sql).toContain("is null");
		expect(params).toEqual([1, 2]);
	});
});

describe("tenantIdAccessible", () => {
	it("admits the active tenant's id", async () => {
		await expect(
			Effect.runPromise(tenantIdAccessible(1).pipe(Effect.provideService(Tenant, tenantA))),
		).resolves.toBe(true);
	});

	it("rejects a foreign tenant id", async () => {
		await expect(
			Effect.runPromise(tenantIdAccessible(2).pipe(Effect.provideService(Tenant, tenantA))),
		).resolves.toBe(false);
	});

	it("is false in personal scope", async () => {
		await expect(Effect.runPromise(tenantIdAccessible(1))).resolves.toBe(false);
	});

	it("honors an explicit TenantAccess set, comparing numerically", async () => {
		await expect(
			Effect.runPromise(withTenantAccess(["4", "5"], tenantIdAccessible(4))),
		).resolves.toBe(true);
		await expect(
			Effect.runPromise(withTenantAccess(["4", "5"], tenantIdAccessible(6))),
		).resolves.toBe(false);
	});
});

describe("tenantRowScope", () => {
	const OWNED_DDL = `
CREATE TABLE test_owned (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, owner_id TEXT, body TEXT NOT NULL);
`;

	const seedOwned = async (sql: SqlDatabase) => {
		const ins = (tenantId: number | null, ownerId: string | null, body: string) =>
			sql
				.prepare("INSERT INTO test_owned (tenant_id, owner_id, body) VALUES (?, ?, ?)")
				.bind(tenantId, ownerId, body)
				.run();
		await ins(1, "u1", "a1");
		await ins(1, "u2", "a2");
		await ins(2, "u1", "b1");
		await ins(null, "u1", "p1");
		await ins(null, "u2", "p2");
	};

	const visibleBodies = (sql: SqlDatabase, tenant: Tenant | null, ownerId: string) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const db = makeDb(sql);
				const scope = yield* tenantRowScope(owned, owned.ownerId, ownerId);
				const rows = yield* Effect.promise(() =>
					db.select({ body: owned.body }).from(owned).where(scope),
				);
				return rows.map((r) => r.body).sort();
			}).pipe(Effect.provideService(Tenant, tenant)),
		);

	it("admits own personal rows plus every row of accessible tenants", async () => {
		const sql = makeTestD1(OWNED_DDL);
		await seedOwned(sql);
		// Tenant A + owner u1: both tenant-1 rows (membership waives the
		// owner check) + u1's personal row — never tenant-2 or u2's
		// personal row.
		await expect(visibleBodies(sql, tenantA, "u1")).resolves.toEqual(["a1", "a2", "p1"]);
		await expect(visibleBodies(sql, tenantB, "u1")).resolves.toEqual(["b1", "p1"]);
	});

	it("degrades to own personal rows in personal scope", async () => {
		const sql = makeTestD1(OWNED_DDL);
		await seedOwned(sql);
		await expect(visibleBodies(sql, null, "u1")).resolves.toEqual(["p1"]);
		await expect(visibleBodies(sql, null, "u2")).resolves.toEqual(["p2"]);
	});
});

describe("scopedRepo reads", () => {
	it("findMany returns own-tenant plus personal rows only", async () => {
		const f = await makeFixture();
		const rows = await repo(f, tenantA, (r) => r.findMany());
		expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
			[f.ids.a1, f.ids.a2, f.ids.p1].sort((a, b) => a - b),
		);
	});

	it("findMany for tenant B mirrors the scope", async () => {
		const f = await makeFixture();
		const rows = await repo(f, tenantB, (r) => r.findMany());
		expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
			[f.ids.b1, f.ids.p1].sort((a, b) => a - b),
		);
	});

	it("personal scope sees only NULL-tenant rows", async () => {
		const f = await makeFixture();
		const rows = await repo(f, null, (r) => r.findMany());
		expect(rows.map((r) => r.id)).toEqual([f.ids.p1]);
	});

	it("findFirst returns the first in-scope row", async () => {
		const f = await makeFixture();
		const row = await repo(f, tenantB, (r) => r.findFirst());
		expect(row?.id).toBe(f.ids.b1);
	});

	it("findFirst returns null when the scope is empty", async () => {
		// Only a tenant-B row and no personal rows: tenant A's scope
		// (tenant_id IN (1) OR IS NULL) matches nothing.
		const sql = makeTestD1(DDL);
		await sql
			.prepare("INSERT INTO test_notes (tenant_id, body) VALUES (?, ?)")
			.bind(2, "b-only")
			.run();
		const f: Fixture = {
			sql,
			db: makeDb(sql),
			live: Layer.succeed(Db, makeDb(sql)),
			ids: { a1: 0, a2: 0, b1: 0, p1: 0 },
		};
		const row = await repo(f, tenantA, (r) => r.findFirst());
		expect(row).toBeNull();
	});

	it("findFirst with a matching condition returns the row", async () => {
		const f = await makeFixture();
		const row = await repo(f, tenantA, (r) => r.findFirst(eq(notes.body, "a2")));
		expect(row?.id).toBe(f.ids.a2);
	});

	it("findFirst with a non-matching condition returns null", async () => {
		const f = await makeFixture();
		const row = await repo(f, tenantA, (r) => r.findFirst(eq(notes.body, "missing")));
		expect(row).toBeNull();
	});

	it("findFirst condition cannot reach foreign-tenant rows", async () => {
		const f = await makeFixture();
		// The condition matches tenant B's row, but the tenant-A scope
		// fence still excludes it — the condition is ANDed, never a
		// substitute for the scope.
		const row = await repo(f, tenantA, (r) => r.findFirst(eq(notes.body, "b1")));
		expect(row).toBeNull();
	});

	it("findMany with a condition filters inside the scope", async () => {
		const f = await makeFixture();
		const rows = await repo(f, tenantA, (r) => r.findMany(eq(notes.tenantId, 1)));
		expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
			[f.ids.a1, f.ids.a2].sort((a, b) => a - b),
		);
	});

	it("findMany condition cannot reach foreign-tenant rows", async () => {
		const f = await makeFixture();
		const rows = await repo(f, tenantA, (r) => r.findMany(eq(notes.body, "b1")));
		expect(rows).toEqual([]);
	});

	it("TenantAccess widens the visible set across tenants", async () => {
		const f = await makeFixture();
		const rows = await withTenant(
			null,
			scopedRepo(notes).pipe(Effect.flatMap((r) => r.findMany())),
			f.live,
		);
		// baseline personal: only p1
		expect(rows.map((r) => r.id)).toEqual([f.ids.p1]);

		const wide = await Effect.runPromise(
			withTenantAccess(
				[1, 2],
				scopedRepo(notes).pipe(
					Effect.flatMap((r) => r.findMany()),
					Effect.provide(f.live),
				),
			),
		);
		expect(wide.map((r) => r.id).sort((a, b) => a - b)).toEqual(
			[f.ids.a1, f.ids.a2, f.ids.b1, f.ids.p1].sort((a, b) => a - b),
		);
	});
});

describe("scopedRepo writes", () => {
	it("insert stamps the active tenant id", async () => {
		const f = await makeFixture();
		const row = await repo(f, tenantA, (r) => r.insert({ body: "new-a" }));
		expect(row?.tenantId).toBe(1);
	});

	it("insert in personal scope stamps NULL", async () => {
		const f = await makeFixture();
		const row = await repo(f, null, (r) => r.insert({ body: "new-p" }));
		expect(row?.tenantId).toBeNull();
	});

	it("insert returns null when RETURNING yields no row", async () => {
		// A driver that returns no rows from INSERT ... RETURNING: the
		// repo degrades to null instead of throwing (same contract the
		// groups plugin tests for its repo helpers).
		const emptyInsert = {
			insert: () => ({ values: () => ({ returning: async () => [] }) }),
		} as unknown as DbClient;
		const row = await Effect.runPromise(
			scopedRepo(notes).pipe(
				Effect.flatMap((r) => r.insert({ body: "ghost" })),
				Effect.provide(Layer.succeed(Db, emptyInsert)),
				Effect.provideService(Tenant, tenantA),
			),
		);
		expect(row).toBeNull();
	});

	it("update cannot touch foreign-tenant rows", async () => {
		const f = await makeFixture();
		const updated = await repo(f, tenantA, (r) =>
			r.update({ body: "hijack" }).where(eq(notes.id, f.ids.b1)),
		);
		expect(updated).toEqual([]);
		const check = await f.db.select().from(notes).where(eq(notes.id, f.ids.b1));
		expect(check[0]?.body).toBe("b1");
	});

	it("update drops tenantId from the patch", async () => {
		const f = await makeFixture();
		const updated = await repo(f, tenantA, (r) =>
			r.update({ body: "moved?", tenantId: 2 }).where(eq(notes.id, f.ids.a1)),
		);
		expect(updated).toHaveLength(1);
		const check = await f.db.select().from(notes).where(eq(notes.id, f.ids.a1));
		expect(check[0]?.tenantId).toBe(1);
		expect(check[0]?.body).toBe("moved?");
	});

	it("remove cannot delete foreign-tenant rows", async () => {
		const f = await makeFixture();
		const removed = await repo(f, tenantA, (r) => r.remove(eq(notes.id, f.ids.b1)));
		expect(removed).toEqual([]);
		const remaining = await repo(f, tenantB, (r) => r.findMany());
		expect(remaining.map((r) => r.id)).toContain(f.ids.b1);
	});

	it("remove deletes in-scope rows", async () => {
		const f = await makeFixture();
		const removed = await repo(f, tenantA, (r) => r.remove(eq(notes.id, f.ids.a2)));
		expect(removed).toHaveLength(1);
		const rows = await repo(f, tenantA, (r) => r.findMany());
		expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
			[f.ids.a1, f.ids.p1].sort((a, b) => a - b),
		);
	});
});

describe("scopedRepo tracing", () => {
	interface RecordedSpan {
		readonly name: string;
		readonly attributes: Map<string, unknown>;
	}

	const recordTracer = () => {
		const spans: RecordedSpan[] = [];
		const tracer = Tracer.make({
			span: (options) => {
				const attributes = new Map<string, unknown>();
				const record: RecordedSpan = { name: options.name, attributes };
				spans.push(record);
				return {
					_tag: "Span",
					name: options.name,
					spanId: `span-${spans.length}`,
					traceId: "trace",
					parent: options.parent,
					annotations: options.annotations,
					status: { _tag: "Started", startTime: options.startTime },
					attributes,
					links: options.links,
					sampled: options.sampled,
					kind: options.kind,
					attribute(key: string, value: unknown) {
						attributes.set(key, value);
					},
					event() {},
					end() {},
					addLinks() {},
				} as Tracer.Span;
			},
		});
		return { tracer, spans };
	};

	it("wraps each repo operation in a db.<op> span tagged with the table", async () => {
		const f = await makeFixture();
		const { tracer, spans } = recordTracer();
		await withTenant(
			tenantA,
			scopedRepo(notes).pipe(
				Effect.flatMap((r) =>
					Effect.all([
						r.findMany(),
						r.findFirst(),
						r.insert({ body: "traced" }),
						r.update({ body: "traced-2" }).where(eq(notes.id, f.ids.a1)),
						r.remove(eq(notes.id, f.ids.a2)),
					]),
				),
				Effect.withTracer(tracer),
			),
			f.live,
		);
		expect(spans.map((s) => s.name).sort()).toEqual(
			["db.findFirst", "db.findMany", "db.insert", "db.remove", "db.update"].sort(),
		);
		for (const span of spans) {
			expect(span.attributes.get("db.table")).toBe("test_notes");
		}
	});
});
