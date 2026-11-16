#!/usr/bin/env bun
/**
 * i18n:import-baseline — imports code-side catalogs into the DB as
 * `global`/`published` rows (PL-008 Phase 1). Idempotent: existing rows
 * are never overwritten (the DB is canonical; panel edits win).
 *
 * Sources: apps/web/messages/*.json → namespace `app` (baseline source), plus every
 * migrated plugin catalog — a plugin opts in by exporting
 * `I18N_NAMESPACE` + `i18nMessagesFor(locale)` from src/i18n.ts
 * (PL-008 Phase 4). String leaves import verbatim; paramMessage
 * function leaves import their i18nTemplate (kind "text"); plain
 * function messages are still skipped with a warning — they migrate
 * to MF1 templates per-key.
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
import { flattenCatalog } from "../packages/i18n/src/catalog.ts";
import { LOCALE_META } from "../packages/i18n/src/locales.ts";
import { isParametrizedMessage, PSEUDO_LOCALE } from "../packages/i18n/src/message.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

const argDb = process.argv.indexOf("--db");
const dbPath =
	argDb !== -1
		? process.argv[argDb + 1]
		: (process.env.DATABASE_URL ?? join(root, "apps/web/data/app.db"));

const messagesDir = join(root, "apps/web/messages");
const migrationsDir = join(root, "packages/db/drizzle");

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
	// qps is a pseudo-locale — catalogs render it from the default
	// locale at slice time, so plugins don't need qps entries.
	for (const locale of Object.keys(LOCALE_META).filter((l) => l !== PSEUDO_LOCALE)) {
		const catalog = mod.i18nMessagesFor(locale);
		// Catalogs are nested message objects — flatten to dot paths
		// (`sections.identification`) so every string leaf imports; the
		// same flattening sliceMessages applies at read time.
		for (const { path: key, value } of flattenCatalog(catalog)) {
			if (typeof value === "string") {
				entries.push({ namespace: mod.I18N_NAMESPACE, key, locale, value });
				continue;
			}
			if (isParametrizedMessage(value)) {
				// paramMessage leaves are MF1 templates at heart — the
				// template is the DB-editable baseline value.
				entries.push({
					namespace: mod.I18N_NAMESPACE,
					key,
					locale,
					kind: "text",
					value: value.i18nTemplate,
				});
				continue;
			}
			pluginWarnings.push(`${mod.I18N_NAMESPACE}.${key} [${locale}]: non-string value skipped`);
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
		.values({
			code,
			endonym: meta.endonym,
			fallbacks: meta.fallbacks,
			// Pseudo-locales stay disabled on import — same rule as the
			// runtime seed; admins opt in via /platform/i18n.
			enabled: code !== PSEUDO_LOCALE,
		})
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
