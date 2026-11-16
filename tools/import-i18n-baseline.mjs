#!/usr/bin/env bun
/**
 * i18n:import-baseline — imports code-side catalogs into the DB as
 * `global`/`published` rows (PL-008 Phase 1). Idempotent: existing rows
 * are never overwritten (the DB is canonical; panel edits win).
 *
 * Sources: apps/web/messages/*.json → namespace `app`, plus every
 * migrated plugin catalog — a plugin opts in by exporting
 * `I18N_NAMESPACE` + `i18nMessagesFor(locale)` from src/i18n.ts
 * (PL-008 Phase 4). Non-string catalog values (function messages)
 * are skipped with a warning; they migrate to MF1 templates per-key.
 *
 * Usage:
 *   bun run i18n:import-baseline [--db <sqlite path>]
 *
 * Default DB: $DATABASE_URL or apps/web/data/app.db — the same file
 * `dev:node` uses. Migrations are applied first via @ktb/db-sqlite.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Migrated plugin catalogs (Phase 4): src/i18n.ts must export
// I18N_NAMESPACE + i18nMessagesFor(locale) → flat string record.
const pluginsDir = join(root, "plugins");
const pluginWarnings = [];
for (const dir of readdirSync(pluginsDir)) {
	const file = join(pluginsDir, dir, "src/i18n.ts");
	if (!existsSync(file)) continue;
	const mod = await import(pathToFileURL(file).href);
	if (typeof mod.I18N_NAMESPACE !== "string" || typeof mod.i18nMessagesFor !== "function") {
		continue;
	}
	for (const locale of Object.keys(LOCALE_META)) {
		const catalog = mod.i18nMessagesFor(locale);
		for (const [key, value] of Object.entries(catalog)) {
			if (typeof value !== "string") {
				pluginWarnings.push(`${mod.I18N_NAMESPACE}.${key} [${locale}]: non-string value skipped`);
				continue;
			}
			entries.push({ namespace: mod.I18N_NAMESPACE, key, locale, value });
		}
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
	console.warn(
		`  invalid ${bad.entry.namespace}.${bad.entry.key} [${bad.entry.locale}]: ${bad.error}`,
	);
}
for (const warn of pluginWarnings) {
	console.warn(`  skipped ${warn}`);
}
if (result.invalid.length > 0) process.exitCode = 1;
