import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

/**
 * Templates: admin-saved snapshots of plugin-owned content, keyed by
 * `kind`. `payload` is the kind-specific JSON document produced by the
 * kind's `serialize` (opaque to this plugin — each kind owns its
 * shape); `name` is unique per `kind` so the same template name can
 * exist across kinds. `createdBy` records the admin email (null when
 * the principal carries none). `updatedAt` drives list ordering and
 * is indexed for that.
 *
 * Plugin-owned table definition (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts — consumers keep
 * importing it from `@ktb/db/schema` (or `@ktb/templates/schema`).
 */
export const templates = sqliteTable(
	"templates",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		kind: text().notNull(),
		name: text().notNull(),
		description: text(),
		payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
		createdBy: text("created_by"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("templates_kind_name_idx").on(table.kind, table.name),
		index("templates_updated_idx").on(table.updatedAt),
	],
);

// Aliased: `Template` alone is too generic at consumer sites.
export type TemplateRow = typeof templates.$inferSelect;
export type TemplateRowInsert = typeof templates.$inferInsert;
