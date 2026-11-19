import { fileURLToPath } from "node:url";

import { makeDb, type DbClient } from "@ktb/db";
import { makeSqliteDatabase } from "@ktb/db-sqlite";

/**
 * job_runs projection store for the Redis jobs worker. Defaults to the
 * SAME SQLite file dev:node uses for the app database
 * (apps/web/data/app.db) so runs consumed off the Redis transport show
 * up in the /platform/queue console alongside the in-app queues.
 *
 * Env:
 *   DATABASE_URL — same convention as dev:node (`sqlite:`/`file:` URLs,
 *     `:memory:`, or a plain path); overrides the default location.
 *   JOBS_DB=off  — disable the projection entirely (transport-side
 *     status only, the pre-projection behavior).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));
const DEFAULT_DB_PATH = fileURLToPath(new URL("../../../apps/web/data/app.db", import.meta.url));

export const openWorkerDb = (env: NodeJS.ProcessEnv = process.env): DbClient | undefined => {
	if (env.JOBS_DB === "off") return undefined;
	const filename = env.DATABASE_URL ?? DEFAULT_DB_PATH;
	return makeDb(makeSqliteDatabase({ filename, migrate: MIGRATIONS_DIR }));
};
