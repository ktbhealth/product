import { sql } from "drizzle-orm";

import { index, integer, sqliteTable, text, uniqueIndex } from "@ktb/db/table";

/**
 * kv_entries (P-090) — the TTL'd, namespaced key/value store plugins
 * use for durable small state instead of bespoke tables. One row per
 * (namespace, key, tenant-scope, owner-scope) slice; `value` is JSON
 * text, `expires_at` is epoch-ms (NULL = never), `version` is the
 * optimistic-concurrency counter bumped by every write.
 *
 * Scope model mirrors the patients tenant semantics (P-053):
 * `tenant_id` NULL + `owner_id` set = personal row owned by that user;
 * `tenant_id` set = tenant-owned row shared by the tenant's members
 * (`owner_id` stays NULL — owner scoping only applies to personal
 * rows); both NULL = deployment-global row.
 *
 * Uniqueness: SQLite treats NULLs as DISTINCT inside unique indexes,
 * so a plain unique index on (namespace, key, tenant_id, owner_id)
 * would let the same logical key be inserted twice whenever a scope
 * column is NULL — which is almost always. `tenant_key`/`owner_key`
 * are generated columns materializing the coalesced scope
 * (`coalesce(tenant_id, -1)` / `coalesce(owner_id, '')`; tenant ids
 * are positive group ids and "" owner ids are rejected by the
 * service, so the sentinels cannot collide with real values) and the
 * unique index targets them, keeping every upsert conflict-targetable.
 */
export const kvEntries = sqliteTable(
	"kv_entries",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		/** Dotted namespace the owning plugin chose, e.g. `patients.sync`. */
		namespace: text("namespace").notNull(),
		key: text("key").notNull(),
		/** NULL = personal/global row; a groups.id = tenant-owned row. */
		tenantId: integer("tenant_id"),
		/** Personal-row owner; NULL on tenant/global rows. */
		ownerId: text("owner_id"),
		/** JSON-serialized value. */
		value: text("value").notNull(),
		/** Epoch ms; NULL = no expiry. Past values are lazily deleted on
		 * read and bulk-removed by `Kv.sweepExpired`. */
		expiresAt: integer("expires_at"),
		/** CAS counter — incremented by every successful write. */
		version: integer("version").notNull().default(1),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		/** Generated coalesce of tenant_id (NULL → -1). */
		tenantKey: integer("tenant_key").generatedAlwaysAs(sql`coalesce("tenant_id", -1)`),
		/** Generated coalesce of owner_id (NULL → ''). */
		ownerKey: text("owner_key").generatedAlwaysAs(sql`coalesce("owner_id", '')`),
	},
	(table) => [
		uniqueIndex("kv_entries_uidx").on(table.namespace, table.key, table.tenantKey, table.ownerKey),
		index("kv_entries_expiry_idx").on(table.expiresAt),
		index("kv_entries_scope_idx").on(table.namespace, table.tenantId, table.ownerId),
	],
);

export type KvEntryRow = typeof kvEntries.$inferSelect;
