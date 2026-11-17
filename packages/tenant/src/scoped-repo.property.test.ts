import { and, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { Db, makeDb, type DbClient } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";

import { Tenant, withTenantAccess } from "./index.ts";
import { scopedRepo, type ScopedRepo } from "./scoped-repo.ts";
import { tenantIdColumn, tenantTable } from "./schema.ts";

/**
 * Property-style tests for the tenant-isolation invariant (P-053).
 *
 * The unit tests in `scoped-repo.test.ts` pin specific scenarios; this
 * suite fuzzes them: a deterministic seeded RNG generates randomized
 * tenant sets, row distributions (tenant-owned + personal `NULL`),
 * accessible-set overrides and operation sequences, then a model of
 * the database is checked against every result the repo returns.
 *
 * Invariants asserted after EVERY operation and re-verified against the
 * raw table at the end of each scenario:
 *
 * - reads (`findMany`/`findFirst`) and write returns (`update`/`remove`)
 *   only ever surface rows whose `tenant_id` is in the accessible set
 *   or `NULL` (personal) — the scope fence is never bypassed;
 * - caller `condition`s only narrow results: every returned row also
 *   satisfies the condition's own predicate;
 * - `insert` stamps the active `Tenant.id` (or `NULL` in personal
 *   scope) even when the values carry a decoy `tenantId`;
 * - `update` never moves a row's `tenant_id` (patch `tenantId` is
 *   dropped) and `remove` never deletes out-of-scope rows — verified
 *   by diffing the whole table against the model at scenario end.
 *
 * Determinism: `mulberry32` replaces a property-testing dependency —
 * every scenario derives from `BASE_SEED + index`, so a failure message
 * names the exact seed to reproduce.
 */

const notes = tenantTable("test_notes", {
	id: integer().primaryKey({ autoIncrement: true }),
	tenantId: tenantIdColumn(),
	body: text().notNull(),
});

const DDL =
	"CREATE TABLE test_notes (" +
	"id INTEGER PRIMARY KEY AUTOINCREMENT, " +
	"tenant_id INTEGER, " +
	"body TEXT NOT NULL" +
	")";

const BASE_SEED = 0x5eed0001;
const SCENARIOS = 400;

/** mulberry32 — tiny deterministic PRNG, ~10 lines, no dependency. */
const mulberry32 = (seed: number): (() => number) => {
	let a = seed | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

type Rng = () => number;

const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, values: readonly T[]): T => values[Math.floor(rng() * values.length)]!;
const chance = (rng: Rng, p: number) => rng() < p;
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

const shuffle = <T>(rng: Rng, values: readonly T[]): T[] => {
	const out = [...values];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
};

interface RowShape {
	readonly id: number;
	readonly tenantId: number | null;
	readonly body: string;
}

/** A caller-supplied WHERE condition plus the JS predicate that models
 * it exactly — returned rows must satisfy BOTH the scope fence and the
 * predicate (conditions narrow, never widen). */
interface FuzzCondition {
	readonly sql: SQL;
	readonly test: (row: RowShape) => boolean;
}

interface CondContext {
	readonly bodies: readonly string[];
	readonly tenantIds: readonly number[];
}

const genCondition = (rng: Rng, ctx: CondContext): FuzzCondition | undefined => {
	if (chance(rng, 0.25)) return undefined;
	const body = () => pick(rng, ctx.bodies);
	const tenantId = () => pick(rng, ctx.tenantIds);
	switch (int(rng, 0, 7)) {
		case 0: {
			const b = body();
			return { sql: eq(notes.body, b), test: (r) => r.body === b };
		}
		case 1: {
			const t = tenantId();
			return { sql: eq(notes.tenantId, t), test: (r) => r.tenantId === t };
		}
		case 2: {
			// Matches nothing — still must not escape the scope.
			const b = `no-such-body-${int(rng, 0, 1_000_000)}`;
			return { sql: eq(notes.body, b), test: (r) => r.body === b };
		}
		case 3: {
			const b = body();
			const t = tenantId();
			return {
				sql: and(eq(notes.body, b), eq(notes.tenantId, t))!,
				test: (r) => r.body === b && r.tenantId === t,
			};
		}
		case 4:
			return { sql: isNull(notes.tenantId), test: (r) => r.tenantId === null };
		case 5:
			return { sql: isNotNull(notes.tenantId), test: (r) => r.tenantId !== null };
		case 6: {
			const b1 = body();
			const b2 = body();
			return {
				sql: or(eq(notes.body, b1), eq(notes.body, b2))!,
				test: (r) => r.body === b1 || r.body === b2,
			};
		}
		default: {
			// An id that is almost certainly absent — narrows to empty.
			const id = int(rng, 1_000, 1_000_000);
			return { sql: eq(notes.id, id), test: (r) => r.id === id };
		}
	}
};

// ---------- scenario generation ----------

type Op =
	| { readonly kind: "findMany"; readonly cond?: FuzzCondition }
	| { readonly kind: "findFirst"; readonly cond?: FuzzCondition }
	| { readonly kind: "insert"; readonly body: string; readonly decoy: number | null }
	| {
			readonly kind: "update";
			readonly body: string;
			readonly decoy: number | null;
			readonly cond?: FuzzCondition;
	  }
	| { readonly kind: "remove"; readonly cond?: FuzzCondition };

interface Scenario {
	/** Tenant ids rows may belong to / access sets may name — a
	 * superset of the ids that have a `Tenant` object. */
	readonly idPool: readonly number[];
	readonly rows: readonly { tenantId: number | null; body: string }[];
	/** `TenantAccess` override; `null` derives the set from `Tenant`. */
	readonly access: readonly number[] | null;
	readonly tenant: Tenant | null;
	readonly ops: readonly Op[];
}

const makeTenant = (id: number): Tenant => ({
	id,
	kind: "clinic",
	slug: `clinic-${id}`,
	role: "member",
});

const genScenario = (rng: Rng, index: number): Scenario => {
	const tenantCount = int(rng, 2, 4);
	// idPool has one extra id with no Tenant object — rows can belong to
	// "unknown" tenants and access sets can name them.
	const idPool = range(tenantCount + 1);
	const rowCount = int(rng, 0, 25);
	const rows = Array.from({ length: rowCount }, (_, i) => ({
		tenantId: chance(rng, 0.25) ? null : pick(rng, idPool),
		body: `s${index}-r${i}`,
	}));
	const access = chance(rng, 0.4)
		? null
		: shuffle(rng, idPool)
				.slice(0, int(rng, 0, idPool.length))
				.sort((a, b) => a - b);
	const tenant = chance(rng, 0.3) ? null : makeTenant(int(rng, 1, tenantCount));
	const bodies = rows.length > 0 ? rows.map((r) => r.body) : [`s${index}-none`];
	const condCtx: CondContext = { bodies, tenantIds: idPool };
	const opCount = int(rng, 4, 14);
	const ops: Op[] = [];
	for (let i = 0; i < opCount; i++) {
		const cond = () => genCondition(rng, condCtx);
		const decoy = () => (chance(rng, 0.8) ? pick(rng, [...idPool, null]) : null);
		switch (int(rng, 0, 4)) {
			case 0:
				ops.push({ kind: "findMany", cond: cond() });
				break;
			case 1:
				ops.push({ kind: "findFirst", cond: cond() });
				break;
			case 2:
				ops.push({ kind: "insert", body: `s${index}-i${i}`, decoy: decoy() });
				break;
			case 3:
				ops.push({
					kind: "update",
					body: `s${index}-u${i}`,
					decoy: decoy(),
					cond: cond(),
				});
				break;
			default:
				ops.push({ kind: "remove", cond: cond() });
				break;
		}
	}
	return { idPool, rows, access, tenant, ops };
};

// ---------- scenario runner ----------

interface RowState {
	readonly tenantId: number | null;
	body: string;
	deleted: boolean;
}

const runScenario = async (seed: number, index: number): Promise<number> => {
	const rng = mulberry32(seed);
	const scenario = genScenario(rng, index);
	const tag = `seed=${seed}`;

	const sql = makeD1(DDL);
	const ins = (tenantId: number | null, body: string) =>
		sql
			.prepare("INSERT INTO test_notes (tenant_id, body) VALUES (?, ?)")
			.bind(tenantId, body)
			.run();
	for (const row of scenario.rows) await ins(row.tenantId, row.body);

	// Model: every row the repo could ever legitimately touch, tracked
	// by id. Seeded rows come back from a raw SELECT.
	const seeded = await sql
		.prepare("SELECT id, tenant_id, body FROM test_notes ORDER BY id")
		.all<{ id: number; tenant_id: number | null; body: string }>();
	const states = new Map<number, RowState>();
	for (const r of seeded.results) {
		states.set(r.id, { tenantId: r.tenant_id, body: r.body, deleted: false });
	}

	// Effective accessible set — mirrors `accessibleTenantIds`:
	// explicit TenantAccess wins, else the active tenant's id.
	const accessIds = new Set<number>(
		scenario.access ?? (scenario.tenant === null ? [] : [Number(scenario.tenant.id)]),
	);
	const inScope = (row: { tenantId: number | null }) =>
		row.tenantId === null || accessIds.has(row.tenantId);
	// `insert` stamps the bound Tenant (never TenantAccess) — NULL in
	// personal scope.
	const stamp = scenario.tenant === null ? null : Number(scenario.tenant.id);

	const db: DbClient = makeDb(sql);
	const live = Layer.succeed(Db, db);
	const run = <A, E>(
		fn: (r: ScopedRepo<typeof notes>) => Effect.Effect<A, E, never>,
	): Promise<A> => {
		const base = scopedRepo(notes).pipe(
			Effect.flatMap(fn),
			Effect.provide(live),
			Effect.provideService(Tenant, scenario.tenant),
		);
		const eff = scenario.access === null ? base : withTenantAccess(scenario.access, base);
		return Effect.runPromise(eff);
	};

	// Every row a repo call returns must sit inside the scope fence and
	// satisfy its caller condition; `checkBody` is off for `update`
	// returns because the patch legitimately rewrites `body`.
	const assertScopedRow = (row: RowShape, cond: FuzzCondition | undefined, checkBody: boolean) => {
		expect(inScope(row), `${tag}: row ${row.id} (tenant_id=${row.tenantId}) escaped scope`).toBe(
			true,
		);
		if (cond !== undefined) {
			expect(cond.test(row), `${tag}: row ${row.id} violated its caller condition`).toBe(true);
		}
		const state = states.get(row.id);
		expect(state, `${tag}: repo returned unknown row id ${row.id}`).toBeDefined();
		expect(state!.deleted, `${tag}: repo returned deleted row ${row.id}`).toBe(false);
		expect(row.tenantId, `${tag}: row ${row.id} tenant_id drifted`).toBe(state!.tenantId);
		if (checkBody) {
			expect(row.body, `${tag}: row ${row.id} body drifted`).toBe(state!.body);
		}
	};

	for (const op of scenario.ops) {
		switch (op.kind) {
			case "findMany": {
				const rows = await run((r) => r.findMany(op.cond?.sql));
				for (const row of rows) assertScopedRow(row, op.cond, true);
				break;
			}
			case "findFirst": {
				const row = await run((r) => r.findFirst(op.cond?.sql));
				if (row !== null) assertScopedRow(row, op.cond, true);
				break;
			}
			case "insert": {
				const row = await run((r) => r.insert({ body: op.body, tenantId: op.decoy }));
				expect(row, `${tag}: insert returned no row`).not.toBeNull();
				expect(row!.tenantId, `${tag}: insert ignored the active tenant stamp`).toBe(stamp);
				expect(row!.body).toBe(op.body);
				states.set(row!.id, { tenantId: row!.tenantId, body: row!.body, deleted: false });
				break;
			}
			case "update": {
				const updated = await run((r) =>
					r.update({ body: op.body, tenantId: op.decoy }).where(op.cond?.sql),
				);
				for (const row of updated) {
					// RETURNING yields post-update values, so the caller
					// condition's body predicate is checked against the
					// pre-image (state) — tenant_id never changes.
					expect(inScope(row), `${tag}: updated row ${row.id} escaped scope`).toBe(true);
					const state = states.get(row.id);
					expect(state, `${tag}: update returned unknown row ${row.id}`).toBeDefined();
					expect(state!.deleted, `${tag}: update returned deleted row ${row.id}`).toBe(false);
					expect(row.tenantId, `${tag}: update moved row ${row.id} across tenants`).toBe(
						state!.tenantId,
					);
					if (op.cond !== undefined) {
						expect(
							op.cond.test({ id: row.id, tenantId: row.tenantId, body: state!.body }),
							`${tag}: updated row ${row.id} violated its caller condition`,
						).toBe(true);
					}
					// The patch cannot move tenant_id, and body is the only
					// other patched column.
					expect(row.body, `${tag}: update wrote unexpected body`).toBe(op.body);
					state!.body = row.body;
				}
				break;
			}
			case "remove": {
				const removed = await run((r) => r.remove(op.cond?.sql));
				for (const row of removed) {
					assertScopedRow(row, op.cond, true);
					states.get(row.id)!.deleted = true;
				}
				break;
			}
		}
	}

	// Whole-table diff: the model must equal the raw table exactly —
	// proves out-of-scope rows were never read-modified, moved, or
	// deleted, and in-scope writes landed as modeled.
	const finalRows = await sql
		.prepare("SELECT id, tenant_id, body FROM test_notes")
		.all<{ id: number; tenant_id: number | null; body: string }>();
	const liveIds = new Set<number>();
	for (const r of finalRows.results) {
		liveIds.add(r.id);
		const state = states.get(r.id);
		expect(state, `${tag}: unexpected row ${r.id} in table`).toBeDefined();
		expect(state!.deleted, `${tag}: deleted row ${r.id} still present`).toBe(false);
		expect(r.tenant_id, `${tag}: row ${r.id} tenant_id mutated`).toBe(state!.tenantId);
		expect(r.body, `${tag}: row ${r.id} body mutated`).toBe(state!.body);
	}
	for (const [id, state] of states) {
		if (state.deleted) {
			expect(liveIds.has(id), `${tag}: row ${id} removed but still present`).toBe(false);
		} else {
			expect(liveIds.has(id), `${tag}: live row ${id} missing from table`).toBe(true);
		}
	}
	return scenario.ops.length;
};

describe("scopedRepo tenant isolation (property fuzz)", () => {
	it("never leaks, moves, or deletes rows outside the accessible tenant set", async () => {
		let ops = 0;
		for (let i = 0; i < SCENARIOS; i++) {
			ops += await runScenario(BASE_SEED + i, i);
		}
		// Sanity: the fuzz really did drive thousands of operations.
		expect(ops).toBeGreaterThan(SCENARIOS * 4);
	}, 60_000);
});
