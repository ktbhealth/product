import Database from "better-sqlite3";

import type { SqlDatabase, SqlResult } from "./index.ts";

/** Bound better-sqlite3 statement carried on each prepared wrapper so
 * `batch` can run the whole set inside ONE transaction (D1 batches are
 * atomic; better-sqlite3 transactions give the same all-or-nothing
 * semantics — mirrors @ktb/db-sqlite). Structural only, not part of the
 * SqlStatement contract. */
interface BoundStatement {
	readonly stmt: Database.Statement;
}

const BOUND = Symbol("ktb.db.testing.bound");

const isBoundStatement = (b: unknown): b is BoundStatement =>
	typeof b === "object" && b !== null && "stmt" in b;

const runBound = <T>(b: BoundStatement): SqlResult<T> => {
	const { stmt } = b;
	if (stmt.reader) {
		return { success: true, results: stmt.all() as T[], meta: {} };
	}
	const r = stmt.run();
	return {
		success: true,
		results: [],
		meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
	};
};

/** In-memory SqlDatabase shim over better-sqlite3 — real SQL for tests. */
export function makeD1(sql?: string): SqlDatabase {
	const sqlite = new Database(":memory:");
	if (sql) sqlite.exec(sql);

	const prepared = (stmt: Database.Statement) =>
		Object.assign(
			{
				bind: (...values: unknown[]) =>
					prepared(stmt.bind(...values.map((v) => (v === undefined ? null : v)))),
				run: async () => runBound({ stmt }),
				all: async <T = Record<string, unknown>>() => ({
					success: true,
					results: stmt.all() as T[],
					meta: {},
				}),
				first: async <T = Record<string, unknown>>() => (stmt.get() as T) ?? null,
				raw: async <T = unknown[]>() => stmt.raw().all() as T[],
				// better-sqlite3 flag: true for SELECT-like statements
				get reader() {
					return stmt.reader;
				},
			},
			{ [BOUND]: { stmt } satisfies BoundStatement },
		);

	return {
		prepare: (q: string) => prepared(sqlite.prepare(q)),
		dump: async () => new ArrayBuffer(0),
		batch: async <T = unknown>(stmts: unknown[]) => {
			const bound = stmts.map(
				(s) => (s as Record<symbol, unknown>)[BOUND] as BoundStatement | undefined,
			);
			if (bound.every(isBoundStatement)) {
				const tx = sqlite.transaction((list: BoundStatement[]) => list.map((b) => runBound<T>(b)));
				return tx(bound);
			}
			// Foreign statements (another SqlDatabase impl): sequential
			// fallback. `reader` is not part of the SqlStatement contract —
			// only `false` is a definite writer signal. A flag-less reader
			// sent through run() would silently return empty results, so
			// prefer all() and fall back to run() only when all() rejects
			// (impls whose all() cannot execute writers).
			return Promise.all(
				stmts.map(async (s) => {
					const p = s as {
						reader?: boolean;
						all: () => Promise<SqlResult<T>>;
						run: () => Promise<SqlResult<T>>;
					};
					if (p.reader === false) return p.run();
					if (p.reader === true) return p.all();
					return p.all().catch(() => p.run());
				}),
			);
		},
		exec: async (q: string) => {
			sqlite.exec(q);
			return { count: 0, duration: 0 };
		},
	} as unknown as SqlDatabase;
}
