import { index, integer, sqliteTable, text } from "@ktb/db/table";

/**
 * Media library images (P-111): admin-uploaded raster assets stored as
 * objects in the deployment's image bucket (R2 in prod, the local
 * filesystem stand-in under dev:node) and referenced by site content —
 * the `"image"` element kind's stored ref, future builder blocks and
 * rich-text embeds.
 *
 * `storageKey` is the object key inside the bucket (never a public URL —
 * bytes are served through `/api/images/:id`, which re-checks the row).
 * `mime`/`size` are the stored object's metadata; `width`/`height` are
 * sniffed at upload time when the format allows (null for SVG and
 * unparseable payloads — the renderer then omits dimension attrs).
 * `title` is the admin-facing label; `alt` is the accessibility text
 * copied into rendered markup (empty string = decorative).
 *
 * Plugin-owned table definition (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts — consumers keep
 * importing it from `@ktb/db/schema` (or `@ktb/image/schema`).
 */
export const images = sqliteTable(
	"images",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		title: text().notNull(),
		alt: text().notNull(),
		mime: text().notNull(),
		size: integer().notNull(),
		storageKey: text("storage_key").notNull(),
		width: integer(),
		height: integer(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("images_created_idx").on(table.createdAt)],
);

export type Image = typeof images.$inferSelect;
export type ImageInsert = typeof images.$inferInsert;
