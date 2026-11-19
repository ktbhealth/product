import { integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

/**
 * Plugin-owned table definitions: aggregated into the drizzle schema
 * by the generated packages/db/src/schema.gen.ts — consumers keep
 * importing them from `@ktb/db/schema` (or `@ktb/fonts/schema`).
 *
 * `font_providers` — one row per configured font source. `kind` names
 * the registered FontProviderAdapter ("local", "googlefonts", or any
 * kind a plugin registers); `config` is adapter-owned JSON.
 *
 * `font_families` — the synced catalog: one row per (provider, family)
 * with the weights the provider offers, a sync `status`
 * ("pending" | "ready" | "failed") and adapter-owned `meta` JSON.
 */
export const fontProviders = sqliteTable("font_providers", {
	id: integer().primaryKey({ autoIncrement: true }),
	/** Registered adapter kind — "local" | "googlefonts" | extensible. */
	kind: text().notNull(),
	name: text().notNull(),
	/** JSON FontProviderConfig | null — adapter-owned. */
	config: text(),
	enabled: integer({ mode: "boolean" }).notNull().default(true),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const fontFamilies = sqliteTable(
	"font_families",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		providerId: integer("provider_id")
			.notNull()
			.references(() => fontProviders.id, { onDelete: "cascade" }),
		family: text().notNull(),
		/** JSON array of ints — the weights the provider offers. */
		weights: text(),
		/** "pending" | "ready" | "failed". */
		status: text().notNull().default("pending"),
		/** JSON adapter-owned variant/info payload | null. */
		meta: text(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [uniqueIndex("font_families_provider_family_idx").on(table.providerId, table.family)],
);
