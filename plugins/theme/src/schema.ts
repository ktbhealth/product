import { integer, sqliteTable, text, uniqueIndex } from "@ktb/db/table";

/**
 * Plugin-owned table definitions (P-061/P-082): aggregated into the
 * drizzle schema by the generated packages/db/src/schema.gen.ts —
 * consumers keep importing them from `@ktb/db/schema` (or
 * `@ktb/theme/schema`).
 *
 * `theme_definitions` — one row per (scope, scope_id): the seeds an
 * admin authored, the derived token map (kept for inspection; resolve
 * re-derives from seeds so the palette engine stays the single source
 * of truth), font config, brand asset refs and the enabled flag.
 * `scope` is "platform" | "tenant" | "portal-instance"; `scope_id` is
 * "" for platform, the tenant id (groups.id) for tenant, and the
 * portal instance id for portal-instance. `is_main` marks the single
 * fallback row resolve() uses after the scope chain misses.
 *
 * `theme_assets` — Phase 4 stub: the async upload/derivative pipeline
 * (R2 + dedicated queue) fills this; v1 rows may reference external
 * URLs directly on `theme_definitions.brand` instead.
 */
export const themeDefinitions = sqliteTable(
	"theme_definitions",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		scope: text().notNull(),
		scopeId: text("scope_id").notNull().default(""),
		appName: text("app_name"),
		/** JSON ThemeSeeds — the admin-authored input. */
		seeds: text().notNull(),
		/** JSON { light, dark } var maps derived at publish time. */
		tokens: text().notNull(),
		/** JSON ThemeFontConfig | null. */
		fonts: text(),
		/** JSON ThemeBrand | null — asset refs (URLs until Phase 4). */
		brand: text(),
		enabled: integer({ mode: "boolean" }).notNull().default(true),
		/** Exactly one row may carry is_main=1 — the resolve() fallback
		 * after the scope chain misses. Set only via setThemeMain (the
		 * admin "Set main" action); publish/upsert never touches it. */
		isMain: integer("is_main", { mode: "boolean" }).notNull().default(false),
		version: integer().notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" }),
	},
	(table) => [uniqueIndex("theme_definitions_scope_idx").on(table.scope, table.scopeId)],
);

export const themeAssets = sqliteTable("theme_assets", {
	id: integer().primaryKey({ autoIncrement: true }),
	themeId: integer("theme_id").references(() => themeDefinitions.id, {
		onDelete: "set null",
	}),
	/** "logo" | "favicon" | "wordmark" | "og-image" | "font". */
	kind: text().notNull(),
	/** R2 object key (Phase 4) — null while the row is a stub/external ref. */
	r2Key: text("r2_key"),
	/** "pending" | "processing" | "ready" | "failed". */
	status: text().notNull().default("pending"),
	/** JSON variants map (size/format → key or URL). */
	variants: text(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
