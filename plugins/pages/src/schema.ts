import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";
import { richText } from "@ktb/rich-text/schema";

/**
 * Custom pages (T-083): admin-authored, DB-stored pages rendered by
 * this plugin through the generic `pages` contribution — one "/*"
 * wildcard descriptor whose guard/loader resolve `path` against this
 * table at request time. The page body is not stored here: `richTextId`
 * references a `rich_text` document (@ktb/rich-text) whose parsed value
 * the wildcard loader resolves at request time — null means the page
 * renders with no body. `published` gates public visibility (drafts
 * 404); `showInNav` + `sortOrder` drive the optional app-header nav
 * listing.
 *
 * Plugin-owned table definition (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts — consumers
 * keep importing it from `@ktb/db/schema` (or `@ktb/pages/schema`).
 */
export const customPage = sqliteTable(
	"custom_pages",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		path: text().notNull(),
		title: text().notNull(),
		richTextId: integer("rich_text_id").references(() => richText.id),
		published: integer({ mode: "boolean" }).notNull().default(false),
		showInNav: integer("show_in_nav", { mode: "boolean" }).notNull().default(false),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		uniqueIndex("custom_pages_path_idx").on(table.path),
		index("custom_pages_nav_idx").on(table.published, table.showInNav),
	],
);

export type CustomPage = typeof customPage.$inferSelect;
export type CustomPageInsert = typeof customPage.$inferInsert;
