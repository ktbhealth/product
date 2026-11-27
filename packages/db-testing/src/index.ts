import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

import { makeDb, type DbClient, type SqlDatabase } from "@ktb/db";
import { applyMigrations } from "@ktb/db-sqlite/migrate";
import { wrapSqliteDatabase, type SqliteDatabase } from "@ktb/db-sqlite";

/**
 * @ktb/db-testing — canonical test double for the platform DB port.
 *
 * Replaces the hand-mirrored `*_TEST_DDL` strings plugin tests used to
 * compose: instead of copy-pasting CREATE TABLEs that drift from the
 * real schema, `makeTestD1`/`makeTestDb` open an in-memory
 * better-sqlite3 database and apply the REAL drizzle migrations
 * (`packages/db/drizzle`, tracked in `__ktb_migrations` by
 * `@ktb/db-sqlite/migrate`). Tests then layer seed INSERTs and fixture
 * tables on top via the `sql` argument.
 *
 * Semantics match `@ktb/db/testing`'s `makeD1` shim: foreign keys are
 * OFF by default (better-sqlite3's default; `makeD1` never enabled
 * them), so fixtures may insert rows in any order. Pass
 * `{ foreignKeys: true }` for tests that want D1-like enforcement.
 */

/** Directory of drizzle-kit migrations applied to every test database. */
export const TEST_MIGRATIONS_DIR = fileURLToPath(new URL("../../db/drizzle/", import.meta.url));

export interface TestDbOptions {
	/**
	 * `PRAGMA foreign_keys` on the underlying handle. Default `false` —
	 * parity with `@ktb/db/testing`'s `makeD1` shim, which never enabled
	 * FK enforcement. Pass `true` to match D1/production enforcement.
	 */
	readonly foreignKeys?: boolean;
}

export interface TestDb {
	/** The raw `SqlDatabase` port (prepare/bind/run/all/batch/exec). */
	readonly d1: SqliteDatabase;
	/** The drizzle client built over `d1` — same as `makeDb(d1)`. */
	readonly db: DbClient;
	/** Close the underlying sqlite handle. */
	close(): void;
}

/**
 * In-memory `SqlDatabase` with every real migration applied, plus any
 * extra fixture SQL (`sql`) exec'd afterwards — seed INSERTs and
 * fixture-only tables that have no drizzle definition. Synchronous:
 * the handle is wrapped before returning, so no await is needed.
 */
export const makeTestD1 = (sql = "", options: TestDbOptions = {}): SqliteDatabase => {
	const sqlite = new Database(":memory:");
	sqlite.pragma(`foreign_keys = ${options.foreignKeys === true ? "ON" : "OFF"}`);
	applyMigrations(sqlite, TEST_MIGRATIONS_DIR);
	if (sql !== "") sqlite.exec(sql);
	return wrapSqliteDatabase(sqlite);
};

/**
 * {@link makeTestD1} plus the drizzle `DbClient` and `close()` — the
 * one-call fixture for tests that previously did
 * `makeDb(makeD1(DDL))`.
 */
export const makeTestDb = (sql = "", options: TestDbOptions = {}): TestDb => {
	const d1 = makeTestD1(sql, options);
	return { d1, db: makeDb(d1), close: () => d1.close() };
};

export type { DbClient, SqlDatabase };
