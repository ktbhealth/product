// Composed schema: table definitions are owned next to their concept —
// plugins/<pkg>/src/schema.ts for plugin-owned tables and
// packages/<pkg>/src/schema.ts for port/infra-owned tables (auth,
// platform, jobs-port, scheduler-port, orchestrator). The GENERATED
// ./schema.gen.ts (tools/gen-db-schema.mjs — `bun run gen:db-schema`,
// verified by the ci:db-schema task) re-exports every owner module so
// `@ktb/db/schema` stays the single import path WITHOUT @ktb/db
// depending on any owning package: the generated file reaches into
// owner sources by relative path, so owners keep importing tables from
// `@ktb/db/schema` (or their own module) without a workspace cycle.
//
// @ktb/db itself is generic: it owns only the SqlDatabase contract,
// makeDb, the Db/Binding services, tx and the testing shim — no product
// table definitions.
export * from "./schema.gen.ts";
