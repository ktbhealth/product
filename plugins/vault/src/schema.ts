import { index, integer, sqliteTable, text, uniqueIndex } from "@ktb/db/table";

import { user } from "@ktb/auth/schema";
import { groups } from "@ktb/groups/schema";

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
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
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
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		// One envelope per (tenant, record, reader) — re-granting
		// replaces. tenantId leads the key so the upsert conflict target
		// can never reach across tenants: entityId is caller-shaped text
		// and two clinics can legitimately name the same (type, id).
		uniqueIndex("entity_deks_record_reader_idx").on(
			table.tenantId,
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
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
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

/**
 * Server-side secrets (P-098 C1): THE credential store — provider API
 * keys, SMTP passwords, `secretRef` material. Distinct from the ZK
 * key-lifecycle tables above: those carry browser-side envelopes the
 * server never opens; this table holds server-side envelope-encrypted
 * values the `Secrets` service opens on resolve.
 *
 * Encryption: each row gets a fresh AES-256 DEK; the VALUE is
 * `aead` ciphertext under it and the DEK is stored only as a
 * `wrapped_dek` envelope under the deployment KEK (`SecretKeyring`
 * port — `VAULT_MASTER_KEY` env driver). Both envelopes carry AAD
 * bound to (scope, name) so ciphertexts cannot be transplanted
 * between secrets.
 *
 * Scoping: `scope` is `"platform"` (tenantId NULL — deployment-wide
 * secrets managed by platform admins) or the tenant id as text.
 * `tenantId` stays a real FK for cascade + queries; `scope` exists
 * because SQLite UNIQUE treats NULLs as distinct, so (scope, name)
 * is the uniqueness that actually holds.
 */
export const vaultSecret = sqliteTable(
	"vault_secret",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		/** "platform" | String(tenantId) — the uniqueness half of (scope,name). */
		scope: text().notNull(),
		/** NULL = platform scope; set = owning clinic (groups.id). */
		tenantId: integer("tenant_id").references(() => groups.id, { onDelete: "cascade" }),
		/** Human label, unique per scope — e.g. "openai-prod", "smtp-main". */
		name: text().notNull(),
		/** Optional provider hint for pickers — "openai", "anthropic", "smtp", … */
		provider: text(),
		/** Non-secret display hint (e.g. last-4 of a key) for masked
		 * reads — never key material. */
		hint: text(),
		/** "api-key" | "token" | "password" | "pem" | "generic". */
		kind: text().notNull().default("generic"),
		/** Per-row DEK wrapped under the deployment KEK (`v1.` envelope + AAD). */
		wrappedDek: text("wrapped_dek").notNull(),
		/** The secret value — `v1.` AES-256-GCM envelope under the row DEK. */
		ciphertext: text().notNull(),
		/** KEK fingerprint that wrapped the DEK (rotation bookkeeping). */
		kekVersion: text("kek_version"),
		/** Bumped on every value/DEK rotation. */
		version: integer().notNull().default(1),
		/** "active" | "disabled" — disabled rows never resolve. */
		status: text().notNull().default("active"),
		createdBy: text("created_by"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
		rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("vault_secret_scope_name_idx").on(table.scope, table.name),
		index("vault_secret_tenant_idx").on(table.tenantId),
	],
);
export type VaultSecret = typeof vaultSecret.$inferSelect;
export type VaultSecretKind = "api-key" | "token" | "password" | "pem" | "generic";
export type VaultSecretStatus = "active" | "disabled";
