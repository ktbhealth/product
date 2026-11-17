import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

// Relative import on purpose (same convention as plugins/patients):
// drizzle-kit loads the composed schema through a CJS resolver that
// cannot follow `@ktb/*` specifiers, and schema.gen.ts reaches plugin
// sources by relative path anyway.
import { groups } from "../../groups/src/schema.ts";

/**
 * Document store tables (P-089): plugin-contributed data collections
 * as DATA, not drizzle tables. `document_collections` is the registry
 * row per contributed collection (name → JSON field schema); every
 * record of every collection lives in `document_records` with its
 * payload in the `data` JSON column — validation happens in the
 * DocumentStore service against the field DSL, not in SQL.
 *
 * `tenant_id` follows the patients pattern: NULL = personal row scoped
 * by `owner_id`; a `groups.id` = tenant-owned row readable by that
 * tenant's members. `owner_id` stays creator/owner attribution either
 * way ("" for system contexts with no principal). The table stays
 * `sqliteTable` (not `tenantTable`) because record queries join scope
 * conditions `scopedRepo` cannot express — fencing goes through
 * `tenantScopeCondition` + owner rules in the service, same as
 * plugins/patients. SET NULL keeps records if the clinic group is
 * deleted.
 */
export const documentCollections = sqliteTable(
	"document_collections",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** Collection name — unique across all contributors. */
		name: text().notNull(),
		/** Owning plugin id (stamped from the contribution when absent). */
		ownerPluginId: text("owner_plugin_id").notNull().default(""),
		/** JSON-serialized DocumentCollection def (fields DSL data). */
		schemaJson: text("schema_json").notNull(),
		/** Highest def version seen — see ensureCollection. */
		version: integer().notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [uniqueIndex("document_collections_name_idx").on(table.name)],
);

export const documentRecords = sqliteTable(
	"document_records",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		collectionId: integer("collection_id")
			.notNull()
			.references(() => documentCollections.id, { onDelete: "cascade" }),
		/** JSON-serialized validated field data. */
		data: text().notNull(),
		/** Owner attribution — "" for system contexts (no principal). */
		ownerId: text("owner_id").notNull().default(""),
		/** NULL = personal row; groups.id = tenant-owned row. */
		tenantId: integer("tenant_id").references(() => groups.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("document_records_collection_idx").on(table.collectionId),
		index("document_records_collection_owner_idx").on(table.collectionId, table.ownerId),
		index("document_records_collection_tenant_idx").on(table.collectionId, table.tenantId),
	],
);

export type DocumentCollectionRow = typeof documentCollections.$inferSelect;
export type DocumentCollectionInsert = typeof documentCollections.$inferInsert;
export type DocumentRecordRow = typeof documentRecords.$inferSelect;
export type DocumentRecordInsert = typeof documentRecords.$inferInsert;
