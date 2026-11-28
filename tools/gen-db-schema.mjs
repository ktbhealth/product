#!/usr/bin/env bun
/**
 * Generates packages/db/src/schema.gen.ts — the aggregated drizzle
 * schema entry point. Table definitions are owned next to their
 * concept: plugins/<pkg>/src/schema.ts for plugin-owned tables and
 * packages/<pkg>/src/schema.ts for port/infra-owned tables (auth,
 * platform, jobs-port, scheduler-port, orchestrator, …). This script
 * re-exports them so `@ktb/db/schema` stays the single import path
 * WITHOUT @ktb/db depending on any owning package (which would
 * recreate the workspace cycle the host-owned layout was built to
 * avoid). The generated file therefore reaches into owner sources by
 * RELATIVE path — it is a source file inside packages/db, not a
 * package.json dependency edge.
 *
 * A schema module (<root>/<pkg>/src/schema.ts) is included only when
 * it actually declares tables (sqliteTable/tenantTable/pgTable call
 * outside comments) — helper/contract schema modules (e.g.
 * packages/tenant's tenantTable alias, packages/anamnesis) are
 * skipped. packages/db itself is never scanned: its schema.ts IS the
 * aggregate.
 *
 * Run after adding/moving a schema module:
 *
 *   bun run gen:db-schema
 *
 * Generated files are never hand-edited. CI verifies they are in sync
 * (ci:db-schema task).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "packages/db/src");
const outPath = join(outDir, "schema.gen.ts");

// Matches a table declaration call: sqliteTable("name", ...),
// tenantTable("name", ...), pgTable("name", ...). Whitespace/newlines
// between the paren and the name are allowed.
const TABLE_DECL_RE = /\b(?:sqliteTable|tenantTable|pgTable)\s*\(\s*["'`]/;

// Strip comments so doc examples (e.g. packages/tenant's
// `tenantTable("notes", …)` snippet) don't read as declarations.
const stripComments = (src) =>
	src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const SCAN_ROOTS = [
	{ dir: join(root, "packages"), skip: new Set(["db"]) },
	{ dir: join(root, "plugins"), skip: new Set() },
];

const owners = [];
for (const { dir, skip } of SCAN_ROOTS) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || skip.has(entry.name)) continue;
		const schemaFile = join(dir, entry.name, "src/schema.ts");
		try {
			if (TABLE_DECL_RE.test(stripComments(readFileSync(schemaFile, "utf8")))) {
				owners.push(schemaFile);
			}
		} catch {
			// No schema.ts — not a schema owner.
		}
	}
}
owners.sort();

const lines = [
	"// GENERATED FILE — do not edit.",
	"// Regenerate with `bun run gen:db-schema` (tools/gen-db-schema.mjs).",
	"// Aggregates owner-declared drizzle table definitions (plugins/*",
	"// and packages/* src/schema.ts modules) for `@ktb/db/schema` and",
	"// drizzle-kit (drizzle.config.ts points here).",
	"// Relative paths are deliberate: @ktb/db must not depend on the",
	"// owning packages — see tools/gen-db-schema.mjs.",
	...owners.map((file) => {
		const spec = relative(outDir, file).split("\\").join("/");
		return `export * from "${spec.startsWith(".") ? spec : `./${spec}`}";`;
	}),
	"",
];

writeFileSync(outPath, lines.join("\n"));
console.log(
	`gen-db-schema: wrote ${outPath} (${owners.length} schema module(s): ${owners.map((f) => f.slice(root.length)).join(", ") || "none"})`,
);
