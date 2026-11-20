import { index, integer, sqliteTable, text } from "@ktb/db/table";

/**
 * Page-body layouts: admin-authored, ordered named sections stored as a
 * JSON config in `config`. Each section binds a content slot — today
 * only `kind: "rich-text"` with `refId` pointing at a `rich_text`
 * document (@ktb/rich-text); `kind` is forward-compatible with a
 * future element-kind registry. `pages.layout_id` selects one
 * layout per page (null = the page renders its single bound document);
 * layouts compose the page BODY only, never app chrome.
 *
 * Plugin-owned table definition (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts — consumers keep
 * importing it from `@ktb/db/schema` (or `@ktb/layouts/schema`).
 */
export const layouts = sqliteTable(
	"layouts",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		name: text().notNull().unique(),
		description: text(),
		config: text().notNull(),
		// Versioned Puck document (PL-014 / P-109): JSON text
		// `{version, data}` written by the site-builder editor. Null =
		// the layout renders the legacy `config` section slots.
		builderJson: text("builder_json"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("layouts_updated_idx").on(table.updatedAt)],
);

export type LayoutRow = typeof layouts.$inferSelect;
export type LayoutRowInsert = typeof layouts.$inferInsert;
