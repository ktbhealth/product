import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeDb, type DbClient } from "@ktb/db";
import { makeSqliteDatabase, sqliteFilename } from "@ktb/db-sqlite";

/**
 * job_runs projection store for the Redis jobs worker. Defaults to the
 * SAME SQLite file dev:node uses for the app database
 * (apps/web/data/app.db) so runs consumed off the Redis transport show
 * up in the /platform/queue console alongside the in-app queues.
 *
 * Env:
 *   DATABASE_URL — same convention as dev:node (`sqlite:`/`file:` URLs,
 *     `:memory:`, or a plain path); overrides the default location.
 *     Relative paths resolve against apps/web — dev:node's cwd — not
 *     the worker's own cwd, so `./data/app.db` still lands on the same
 *     file the app writes.
 *   JOBS_DB=off  — disable the projection entirely (transport-side
 *     status only, the pre-projection behavior).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));
const DEFAULT_DB_PATH = fileURLToPath(new URL("../../../apps/web/data/app.db", import.meta.url));
// dev:node runs `bun --cwd apps/web dev:node`, so its relative
// DATABASE_URL paths resolve against apps/web. The worker is launched
// from the repo root or apps/jobs-worker — anchor relative paths to
// apps/web instead of process.cwd() to keep both processes on the
// same SQLite file.
const WEB_DIR = dirname(dirname(DEFAULT_DB_PATH));

export const workerDbFilename = (input: string): string => {
	const filename = sqliteFilename(input);
	return filename === ":memory:" || isAbsolute(filename) ? filename : resolve(WEB_DIR, filename);
};

export const openWorkerDb = (env: NodeJS.ProcessEnv = process.env): DbClient | undefined => {
	if (env.JOBS_DB === "off") return undefined;
	const filename =
		env.DATABASE_URL === undefined ? DEFAULT_DB_PATH : workerDbFilename(env.DATABASE_URL);
	return makeDb(makeSqliteDatabase({ filename, migrate: MIGRATIONS_DIR }));
};
