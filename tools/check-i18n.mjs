#!/usr/bin/env bun
/**
 * i18n:doctor — health-check the i18n tables in a local database
 * (PL-008 / P-088). Read-only: never migrates, never writes.
 *
 * Reports:
 *   - i18n_namespaces rows vs the namespaces declared in
 *     packages/i18n/src/manifest.gen.ts (missing = warning)
 *   - enabled/disabled locales from i18n_locales
 *   - i18n_messages totals split draft/published, plus per-namespace
 *     counts
 *   - the i18n_revision catalog stamp
 *   - empty/unseeded detection
 *
 * Exit code: 0 healthy (warnings allowed), 1 when the DB is missing,
 * unmigrated, or has no i18n data at all.
 *
 * Usage:
 *   bun run i18n:doctor [--db <sqlite path>]
 *
 * Default DB: $DATABASE_URL or apps/web/data/app.db — the same file
 * `dev:node` uses. Remote D1 is not probed directly; to check prod,
 * export from D1 (`wrangler d1 export`) or run the import-baseline
 * --sql dry-run against a local copy.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeDb } from "@ktb/db";
import { makeSqliteDatabase, sqliteFilename } from "@ktb/db-sqlite";

import { I18N_MANIFEST } from "../packages/i18n/src/manifest.gen.ts";
import {
	i18nLocales,
	i18nMessages,
	i18nNamespaces,
	i18nRevision,
} from "../plugins/i18n/src/schema.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

const argDb = process.argv.indexOf("--db");
const dbPath =
	argDb !== -1
		? process.argv[argDb + 1]
		: (process.env.DATABASE_URL ?? join(root, "apps/web/data/app.db"));

const manifestNamespaces = new Set(Object.keys(I18N_MANIFEST));

const fail = (msg) => {
	console.error(`i18n:doctor ✗ ${msg}`);
	console.error(
		"  hint: prod D1 is checked indirectly — export it or apply " +
			"`bun run i18n:import-baseline --sql out.sql` then " +
			"`wrangler d1 execute <db> --remote --file=out.sql`",
	);
	process.exit(1);
};

if (!existsSync(sqliteFilename(dbPath))) {
	fail(`no database at ${dbPath} (set DATABASE_URL or pass --db)`);
}

// Read-only open, NO migrations: a doctor must never mutate the DB it
// inspects. Missing i18n tables surface as query errors below.
const sqlDb = makeSqliteDatabase({ filename: dbPath, readonly: true, migrate: undefined });
const db = makeDb(sqlDb);

let namespaces;
let locales;
let messageStats;
let revisionRows;
try {
	namespaces = await db.select().from(i18nNamespaces);
	locales = await db.select().from(i18nLocales);
	// Tally in JS — the doctor is a local ops tool, not a hot path, and
	// keeping drizzle-orm out of tools/ avoids a root devDep.
	messageStats = await db
		.select({ namespace: i18nMessages.namespace, status: i18nMessages.status })
		.from(i18nMessages);
	revisionRows = await db.select().from(i18nRevision);
} catch (error) {
	fail(`i18n tables unreadable (${String(error).split("\n")[0]}) — run db:migrate first`);
}

const nsSet = new Set(namespaces.map((r) => r.namespace));
const missing = [...manifestNamespaces].filter((ns) => !nsSet.has(ns)).sort();
const extra = [...nsSet].filter((ns) => !manifestNamespaces.has(ns)).sort();

const totals = { draft: 0, published: 0 };
const perNamespace = new Map();
for (const row of messageStats) {
	totals[row.status] += 1;
	const cur = perNamespace.get(row.namespace) ?? { draft: 0, published: 0 };
	cur[row.status] += 1;
	perNamespace.set(row.namespace, cur);
}
const totalMessages = totals.draft + totals.published;

const enabled = locales.filter((l) => l.enabled).map((l) => l.code);
const disabled = locales.filter((l) => !l.enabled).map((l) => l.code);
const revision = revisionRows[0]?.revision ?? null;

console.log(`i18n:doctor → ${dbPath}`);
console.log(`  namespaces: ${namespaces.length} rows (${manifestNamespaces.size} in manifest)`);
for (const ns of missing) console.log(`    ⚠ manifest namespace missing from DB: ${ns}`);
for (const ns of extra) console.log(`    · DB namespace not in manifest: ${ns}`);
console.log(
	`  locales: ${enabled.length} enabled [${enabled.join(", ") || "none"}]` +
		(disabled.length ? ` · ${disabled.length} disabled [${disabled.join(", ")}]` : ""),
);
console.log(
	`  messages: ${totalMessages} total — ${totals.published} published, ${totals.draft} draft`,
);
for (const [ns, counts] of [...perNamespace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
	console.log(`    ${ns}: ${counts.published} published, ${counts.draft} draft`);
}
console.log(`  i18n_revision: ${revision === null ? "(no row)" : revision}`);

const unseeded = namespaces.length === 0 && totalMessages === 0;
if (unseeded) {
	fail("database has no i18n data — run `bun run db:migrate` then `bun run i18n:import-baseline`");
}
if (missing.length > 0) {
	console.warn(
		`i18n:doctor ⚠ ${missing.length} manifest namespace(s) absent — ` +
			"re-run i18n:import-baseline to backfill",
	);
}
console.log("i18n:doctor ✓ ok");
