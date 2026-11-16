#!/usr/bin/env bun
/**
 * i18n:import-baseline — imports code-side catalogs into the DB as
 * `global`/`published` rows (PL-008 Phase 1). Idempotent: existing rows
 * are never overwritten (the DB is canonical; panel edits win).
 *
 * Sources today: apps/web/messages/*.json → namespace `app`.
 * Plugin catalogs join per-plugin during Phase 4 migrations.
 *
 * Usage:
 *   bun run i18n:import-baseline [--db <sqlite path>]
 *
 * Default DB: $DATABASE_URL or apps/web/data/app.db — the same file
 * `dev:node` uses. Migrations are applied first via @ktb/db-sqlite.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeDb } from "@ktb/db";
import { makeSqliteDatabase } from "@ktb/db-sqlite";

import { syncBaseline } from "../plugins/i18n/src/baseline.ts";
import { i18nLocales } from "../plugins/i18n/src/schema.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

const argDb = process.argv.indexOf("--db");
const dbPath =
	argDb !== -1
		? process.argv[argDb + 1]
		: (process.env.DATABASE_URL ?? join(root, "apps/web/data/app.db"));

const messagesDir = join(root, "apps/web/messages");
const migrationsDir = join(root, "packages/db/drizzle");

const LOCALE_META = {
	en: { endonym: "English", fallbacks: [] },
	"pt-BR": { endonym: "Português (Brasil)", fallbacks: ["en"] },
	es: { endonym: "Español", fallbacks: ["en"] },
};

const entries = [];
for (const file of readdirSync(messagesDir).filter((f) => f.endsWith(".json"))) {
	const locale = file.slice(0, -".json".length);
	const catalog = JSON.parse(readFileSync(join(messagesDir, file), "utf8"));
	for (const [key, value] of Object.entries(catalog)) {
		entries.push({ namespace: "app", key, locale, value });
	}
}

const sqlDb = makeSqliteDatabase({ filename: resolve(dbPath), migrate: migrationsDir });
const db = makeDb(sqlDb);

const result = await syncBaseline(db, entries);

// Locale rows — runtime data; new locales need no rebuild (P-083).
for (const [code, meta] of Object.entries(LOCALE_META)) {
	await db
		.insert(i18nLocales)
		.values({ code, endonym: meta.endonym, fallbacks: meta.fallbacks, enabled: true })
		.onConflictDoNothing();
}

console.log(
	`i18n:import-baseline → ${dbPath}\n` +
		`  inserted: ${result.inserted}\n` +
		`  skipped (already present): ${result.skipped}\n` +
		`  invalid: ${result.invalid.length}`,
);
for (const bad of result.invalid) {
	console.warn(`  invalid app.${bad.entry.key} [${bad.entry.locale}]: ${bad.error}`);
}
if (result.invalid.length > 0) process.exitCode = 1;
