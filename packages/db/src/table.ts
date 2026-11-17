/**
 * Dialect facade for the table DSL — the single import point every
 * schema definition goes through. Today it re-exports drizzle's
 * sqlite-core builders under their usual names; a future dialect swap
 * (SQLite → Postgres) becomes a one-file change here instead of an
 * edit in ~35 schema modules. Call sites keep writing
 * `sqliteTable`/`integer`/`text`/… exactly as before — the identifiers
 * are what matters, not the specifier they resolve through.
 *
 * Schema files that drizzle-kit loads (plugins/*\/src/schema.ts)
 * reach this module by relative path on purpose — see the import
 * comments in those files.
 */
export * from "drizzle-orm/sqlite-core";
