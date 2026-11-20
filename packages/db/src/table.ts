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
 * import this module as `@ktb/db/table` — drizzle-kit's tsx loader
 * resolves workspace package specifiers fine (T-143); only
 * undeclared deps fail, so every FK-target plugin is a real
 * `dependencies` edge in the importer's package.json.
 */
export * from "drizzle-orm/sqlite-core";
