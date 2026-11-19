import { index, integer, sqliteTable, text } from "../../../packages/db/src/table.ts";

/**
 * Rich-text documents: admin-authored documents edited with the Plate-based
 * `RichTextEditor` (`@ktbhealth/ui`) and stored as a JSON-serialized Plate
 * `Value` (node array) in `value`. `title` is the admin-facing label used
 * by the console list and by consumers that pick documents (e.g. the pages
 * plugin doc picker); `updatedAt` drives list ordering and is indexed for
 * that.
 *
 * Plugin-owned table definition (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts — consumers keep
 * importing it from `@ktb/db/schema` (or `@ktb/rich-text/schema`).
 */
export const richText = sqliteTable(
	"rich_text",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		title: text().notNull(),
		value: text().notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("rich_text_updated_idx").on(table.updatedAt)],
);

export type RichText = typeof richText.$inferSelect;
export type RichTextInsert = typeof richText.$inferInsert;
