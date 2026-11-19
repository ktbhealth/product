import { index, integer, sqliteTable, text } from "../../../packages/db/src/table.ts";

/**
 * Managed JSON Schemas: admin-authored draft-2020-12 subset schemas
 * (`@ktb/json-schema`) stored as a JSON string in `schema`. `name` is
 * the unique registry key consumers reference (e.g. page search-param
 * validation); `description` is the admin-facing note shown in the
 * console list; `updatedAt` drives list ordering and is indexed for
 * that.
 *
 * Plugin-owned table definition (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts — consumers keep
 * importing it from `@ktb/db/schema` (or `@ktb/schemas/schema`).
 */
export const schemas = sqliteTable(
	"schemas",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		name: text().notNull().unique(),
		description: text(),
		schema: text().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("schemas_updated_idx").on(table.updatedAt)],
);

// Aliased: `Schema` alone collides with effect/Schema at consumer sites.
export type SchemaRow = typeof schemas.$inferSelect;
export type SchemaRowInsert = typeof schemas.$inferInsert;
