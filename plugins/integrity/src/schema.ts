import { index, integer, sqliteTable, text, uniqueIndex } from "@ktb/db/table";

/**
 * Append-only, entity-generic record versions (PL-007 F1, T-138): one
 * row per material change to a versioned document owned by ANY plugin —
 * `entity_type` + `entity_id` name the record (e.g.
 * `"consultation.anamnesis"` + the consultation id) so no per-entity
 * table or kernel union is needed.
 *
 * `content_hash` is SHA-256 over the CANONICAL plaintext document (the
 * legal integrity hash — key order and unicode normalization inert).
 * `blob_hash` is SHA-256 over the stored `payload` bytes — a corruption
 * check that stays meaningful once `payload` becomes AEAD ciphertext
 * under ZK tenants. `signature` holds the clinic's client-side ECDSA
 * signature over `content_hash` — NULL until clinic keyring onboarding
 * (PL-007 F2) fills it in. `prev_hash` links each row to the previous
 * version's `content_hash`, making silent history rewrites detectable.
 *
 * Plugin-owned table definition (P-061): aggregated into the drizzle
 * schema by the generated packages/db/src/schema.gen.ts — consumers
 * keep importing it from `@ktb/db/schema` (or `@ktb/integrity/schema`).
 */
export const recordVersions = sqliteTable(
	"record_versions",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** Namespaced document kind — "<domain>.<field>" (e.g. "consultation.anamnesis"). */
		entityType: text("entity_type").notNull(),
		/** The owning record's id as text — entity-agnostic (numeric ids stringify). */
		entityId: text("entity_id").notNull(),
		/** 1-based, monotonically increasing per (entity_type, entity_id). */
		version: integer().notNull(),
		/** SHA-256 hex over the canonical plaintext document. */
		contentHash: text("content_hash").notNull(),
		/** Client ECDSA P-256 signature (r||s, b64u) over content_hash — NULL until ZK signing. */
		signature: text(),
		/** Previous version's content_hash — the chain link (NULL on version 1). */
		prevHash: text("prev_hash"),
		/** Stored snapshot: canonical JSON today, AEAD ciphertext for ZK tenants. */
		payload: text().notNull(),
		/** SHA-256 hex over `payload` bytes — corruption check over the stored blob. */
		blobHash: text("blob_hash").notNull(),
		/** Writing user (bound Principal at write time); NULL for system paths. */
		actorUserId: text("actor_user_id"),
		/** Producing engine (e.g. the anamnesis extractor) — provenance only. */
		engine: text(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("record_versions_entity_idx").on(table.entityType, table.entityId),
		uniqueIndex("record_versions_entity_version_idx").on(
			table.entityType,
			table.entityId,
			table.version,
		),
	],
);

export type RecordVersion = typeof recordVersions.$inferSelect;
