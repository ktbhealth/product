import { index, integer, sqliteTable, text, uniqueIndex } from "@ktb/db/table";

import { groups } from "@ktb/groups/schema";

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
		/** Def `version` the stored `data` was written/migrated under
		 * (T-130). Pre-existing rows default to 1 = "unversioned"; the
		 * service migrates lazily on read and stamps the current def
		 * version on write. */
		schemaVersion: integer("schema_version").notNull().default(1),
		/** Row version for optimistic concurrency (T-127): starts at 1
		 * and bumps on every committed record write (each merged batch
		 * write counts once). Distinct from `schema_version`, which
		 * versions the FIELD SCHEMA the payload was written under —
		 * `update(..., { expectedVersion })` is the If-Match guard, and
		 * schema-migration sweeps deliberately do NOT bump it (a def
		 * upgrade is not a user edit). */
		version: integer("version").notNull().default(1),
		/** Owner attribution — "" for system contexts (no principal). */
		ownerId: text("owner_id").notNull().default(""),
		/** NULL = personal row; groups.id = tenant-owned row. */
		tenantId: integer("tenant_id").references(() => groups.id, {
			onDelete: "set null",
		}),
		/** Caller-supplied idempotency key (T-127): unique per
		 * (collection_id, key) when non-NULL — SQLite treats NULLs as
		 * distinct, so keyless inserts never collide. A repeated insert
		 * with the same key replays the existing record. */
		idempotencyKey: text("idempotency_key"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("document_records_collection_idx").on(table.collectionId),
		index("document_records_collection_owner_idx").on(table.collectionId, table.ownerId),
		index("document_records_collection_tenant_idx").on(table.collectionId, table.tenantId),
		uniqueIndex("document_records_idempotency_idx").on(table.collectionId, table.idempotencyKey),
	],
);

export type DocumentCollectionRow = typeof documentCollections.$inferSelect;
export type DocumentCollectionInsert = typeof documentCollections.$inferInsert;
export type DocumentRecordRow = typeof documentRecords.$inferSelect;
export type DocumentRecordInsert = typeof documentRecords.$inferInsert;
