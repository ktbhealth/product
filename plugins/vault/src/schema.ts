import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Relative import — same rationale as @ktb/audit: @ktb/groups depends
// on @ktb/db transitively and @ktb/db's generated schema re-exports
// this module, so a package-specifier import would cycle. The FK
// target is identical either way.
import { groups } from "../../groups/src/schema.ts";
import { user } from "../../../packages/db/src/auth.ts";

/**
 * Clinic member-device key registrations (PL-007 F2, T-142): one row
 * per (tenant, device) — the device publishes its NON-EXTRACTABLE
 * browser keypair's public halves here (`wrapPublicKey` ECDH P-256,
 * `signPublicKey` ECDSA P-256, both b64url raw from `@ktb/crypto/keyring`).
 *
 * Enrollment lifecycle: a member registers → `pending`; an admin
 * approves → `approved` and `wrappedMasterKey` is filled with the
 * clinic master key wrapped to THIS device's pubkey (computed
 * client-side by the approving device — the server only ever stores
 * `w1.` envelopes, never key material); `revoked` devices keep their
 * row for audit but receive no further wraps. `signPublicKey` is what
 * verifies client-signed `record_versions.signature` values.
 *
 * The `tenant_id` column is declared inline (`integer("tenant_id")`,
 * same shape as `@ktb/tenant`'s `tenantIdColumn`) because @ktb/tenant
 * depends on @ktb/db — importing it here would create a workspace
 * cycle. Cascades on group deletion: the clinic's key set dies with it.
 */
export const clinicKeys = sqliteTable(
	"clinic_keys",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		tenantId: integer("tenant_id")
			.notNull()
			.references(() => groups.id, { onDelete: "cascade" }),
		/** Member user id — the device's owner. */
		userId: text("user_id").notNull(),
		/** Device ECDH P-256 wrap pubkey (b64u raw) — envelopes address THIS. */
		wrapPublicKey: text("wrap_public_key").notNull(),
		/** Device ECDSA P-256 sign pubkey (b64u raw) — verifies signed versions. */
		signPublicKey: text("sign_public_key").notNull(),
		/** Clinic master key wrapped to this device (`w1.` envelope) —
		 * NULL while pending; filled at approval. */
		wrappedMasterKey: text("wrapped_master_key"),
		/** "pending" | "approved" | "revoked". */
		status: text().notNull().default("pending"),
		approvedByUserId: text("approved_by_user_id"),
		approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		// A device (wrap pubkey) enrolls once per clinic — re-registration
		// returns the same row (idempotent enroll).
		uniqueIndex("clinic_keys_tenant_wrap_idx").on(table.tenantId, table.wrapPublicKey),
		index("clinic_keys_tenant_user_idx").on(table.tenantId, table.userId),
		index("clinic_keys_tenant_status_idx").on(table.tenantId, table.status),
	],
);

export type ClinicKey = typeof clinicKeys.$inferSelect;
export type ClinicKeyStatus = "pending" | "approved" | "revoked";

/**
 * Per-record DEK grants (PL-007 F2, T-142): each row is one
 * AES-256-GCM record key wrapped (`w1.` envelope) to ONE reader's
 * wrap pubkey — a clinic member device (`readerKind: "device"`) or a
 * patient-portal device (`readerKind: "patient"`). The envelope is
 * opaque to the server; readers unwrap it client-side with
 * `@ktb/crypto/keyring`'s `unwrapKey`.
 *
 * `entityType` + `entityId` name the record generically (same
 * convention as `record_versions` — e.g. `"patient"`, `"consultation"`,
 * numeric ids stringified) so no per-entity grant table is needed.
 * `readerId` is optional correlation data (member user id / patient
 * id) for display and bulk revocation — the pubkey is the authority.
 */
export const entityDeks = sqliteTable(
	"entity_deks",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		tenantId: integer("tenant_id")
			.notNull()
			.references(() => groups.id, { onDelete: "cascade" }),
		/** Record kind — same namespacing as record_versions. */
		entityType: text("entity_type").notNull(),
		/** The owning record's id as text — entity-agnostic. */
		entityId: text("entity_id").notNull(),
		/** "device" (clinic member device) | "patient" (portal grant). */
		readerKind: text("reader_kind").notNull(),
		/** Recipient ECDH P-256 wrap pubkey the envelope is addressed to. */
		readerPubkey: text("reader_pubkey").notNull(),
		/** Optional correlation: member user id or patient id. */
		readerId: text("reader_id"),
		/** The wrapped DEK — `w1.` ECIES envelope, opaque to the server. */
		wrappedDek: text("wrapped_dek").notNull(),
		grantedByUserId: text("granted_by_user_id"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		// One envelope per (record, reader) — re-granting replaces.
		uniqueIndex("entity_deks_record_reader_idx").on(
			table.entityType,
			table.entityId,
			table.readerPubkey,
		),
		index("entity_deks_tenant_record_idx").on(table.tenantId, table.entityType, table.entityId),
		// "Everything I can read" — portal lists and member lookups by pubkey.
		index("entity_deks_reader_idx").on(table.readerPubkey),
	],
);

export type EntityDek = typeof entityDeks.$inferSelect;
export type EntityDekReaderKind = "device" | "patient";

/**
 * Patient-portal device keys (PL-007 F3, T-148): the NON-MEMBER
 * counterpart of `clinic_keys` — one row per (portal user, device).
 * A portal user generates the same non-extractable browser keypair a
 * clinic device does (`@ktb/crypto/keyring`) and publishes its public
 * halves here so an approved clinic device can address `entity_deks`
 * envelopes (`readerKind: "patient"`) to them.
 *
 * Not tenant-scoped on purpose: a portal identity belongs to the user,
 * who may hold `patient_access` links to records kept by several
 * clinics — the same device reads envelopes from every tenant that
 * granted it. Registration is self-service and idempotent (re-register
 * returns the existing row); revocation of a device's read access
 * happens per record via `entity_deks` deletion.
 */
export const portalKeys = sqliteTable(
	"portal_keys",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** Portal account that owns the device — dies with the user. */
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** Device ECDH P-256 wrap pubkey (b64u raw) — envelopes address THIS. */
		wrapPublicKey: text("wrap_public_key").notNull(),
		/** Device ECDSA P-256 sign pubkey (b64u raw) — kept for parity with
		 * clinic devices; nothing verifies portal signatures yet. */
		signPublicKey: text("sign_public_key").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		// A device (wrap pubkey) enrolls once per user — re-registration
		// returns the same row (idempotent enroll). The same physical
		// device MAY serve two accounts (shared browser profile), so the
		// pubkey alone is not unique.
		uniqueIndex("portal_keys_user_wrap_idx").on(table.userId, table.wrapPublicKey),
		// "Which account published this reader pubkey" — grant audits.
		index("portal_keys_wrap_idx").on(table.wrapPublicKey),
	],
);

export type PortalKey = typeof portalKeys.$inferSelect;
