import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { and, eq, inArray } from "drizzle-orm";
import { KeyRoundIcon } from "lucide-react";

import { Principal } from "@ktb/authz";
import { Db, type DbClient } from "@ktb/db";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { requireTenantRole, Tenant, TenantForbidden, tenantScopeId } from "@ktb/tenant";

import { VaultClinicPage } from "./vault-page.tsx";

import {
	clinicKeys,
	entityDeks,
	portalKeys,
	type ClinicKey,
	type EntityDek,
	type EntityDekReaderKind,
	type PortalKey,
} from "./schema.ts";
import { groups } from "../../groups/src/schema.ts";

export type {
	ClinicKey,
	ClinicKeyStatus,
	EntityDek,
	EntityDekReaderKind,
	PortalKey,
} from "./schema.ts";
export { clinicKeys, entityDeks, portalKeys } from "./schema.ts";

/** Vault operation failures distinct from authz — missing rows,
 * wrong lifecycle state, duplicate grants. */
export class VaultError extends Data.TaggedError("VaultError")<{
	readonly reason: "device-not-found" | "device-not-pending" | "tenant-mismatch";
}> {}

/**
 * Assert the bound tenant is exactly `tenantId` and the caller's role
 * ranks at/above `min`. Vault rows are tenant-owned by construction —
 * operating on a different tenant's vault than the one bound is a
 * `tenant-mismatch` error (not a silent cross-tenant reach).
 */
const requireBoundTenant = (
	tenantId: number,
	min: "member" | "admin",
): Effect.Effect<void, VaultError | TenantForbidden> =>
	Effect.gen(function* () {
		const tenant = yield* Tenant;
		if (tenant === null || Number(tenant.id) !== tenantId)
			return yield* Effect.fail(new VaultError({ reason: "tenant-mismatch" }));
		yield* requireTenantRole(min, `vault.${min}`);
	});

// ── Repo functions (testable, no service context) ────────────────

export async function enrollClinicDevice(
	db: DbClient,
	input: {
		readonly tenantId: number;
		readonly userId: string;
		readonly wrapPublicKey: string;
		readonly signPublicKey: string;
	},
): Promise<ClinicKey> {
	// Idempotent on (tenant, wrap pubkey) — a device that re-registers
	// (reload, retry) gets its existing row back, whatever its status.
	const existing = await db
		.select()
		.from(clinicKeys)
		.where(
			and(
				eq(clinicKeys.tenantId, input.tenantId),
				eq(clinicKeys.wrapPublicKey, input.wrapPublicKey),
			),
		)
		.limit(1);
	if (existing[0] !== undefined) return existing[0];
	const rows = await db
		.insert(clinicKeys)
		.values({
			tenantId: input.tenantId,
			userId: input.userId,
			wrapPublicKey: input.wrapPublicKey,
			signPublicKey: input.signPublicKey,
			status: "pending",
			createdAt: new Date(),
		})
		.returning();
	return rows[0]!;
}

export async function listClinicDevices(db: DbClient, tenantId: number): Promise<ClinicKey[]> {
	return db.select().from(clinicKeys).where(eq(clinicKeys.tenantId, tenantId));
}

export async function getClinicDevice(
	db: DbClient,
	tenantId: number,
	clinicKeyId: number,
): Promise<ClinicKey | null> {
	const rows = await db
		.select()
		.from(clinicKeys)
		.where(and(eq(clinicKeys.tenantId, tenantId), eq(clinicKeys.id, clinicKeyId)))
		.limit(1);
	return rows[0] ?? null;
}

/** Device row for a pubkey — the client's enrollment-status poll and
 * master-unwrap fetch (`wrappedMasterKey` travels only to its device). */
export async function deviceByWrapPubkey(
	db: DbClient,
	tenantId: number,
	wrapPublicKey: string,
): Promise<ClinicKey | null> {
	const rows = await db
		.select()
		.from(clinicKeys)
		.where(and(eq(clinicKeys.tenantId, tenantId), eq(clinicKeys.wrapPublicKey, wrapPublicKey)))
		.limit(1);
	return rows[0] ?? null;
}

/** Mark a device approved — the service layer checks the row exists
 * and is pending before calling this (typed errors live there). */
export async function approveClinicDevice(
	db: DbClient,
	input: {
		readonly clinicKeyId: number;
		readonly wrappedMasterKey: string;
		readonly approvedByUserId: string;
	},
): Promise<ClinicKey> {
	const rows = await db
		.update(clinicKeys)
		.set({
			status: "approved",
			wrappedMasterKey: input.wrappedMasterKey,
			approvedByUserId: input.approvedByUserId,
			approvedAt: new Date(),
		})
		.where(eq(clinicKeys.id, input.clinicKeyId))
		.returning();
	return rows[0]!;
}

export async function revokeClinicDevice(db: DbClient, clinicKeyId: number): Promise<ClinicKey> {
	const rows = await db
		.update(clinicKeys)
		.set({ status: "revoked" })
		.where(eq(clinicKeys.id, clinicKeyId))
		.returning();
	return rows[0]!;
}

/** Insert-or-replace DEK envelopes for a record — the write path for
 * record creation (fresh DEK minted client-side) and access grants. */
export async function grantEntityDeks(
	db: DbClient,
	input: {
		readonly tenantId: number;
		readonly entityType: string;
		readonly entityId: string | number;
		readonly grantedByUserId: string | null;
		readonly grants: readonly {
			readonly readerKind: EntityDekReaderKind;
			readonly readerPubkey: string;
			readonly readerId?: string | null;
			readonly wrappedDek: string;
		}[];
	},
): Promise<EntityDek[]> {
	const entityId = String(input.entityId);
	const written: EntityDek[] = [];
	for (const grant of input.grants) {
		const rows = await db
			.insert(entityDeks)
			.values({
				tenantId: input.tenantId,
				entityType: input.entityType,
				entityId,
				readerKind: grant.readerKind,
				readerPubkey: grant.readerPubkey,
				readerId: grant.readerId ?? null,
				wrappedDek: grant.wrappedDek,
				grantedByUserId: input.grantedByUserId,
				createdAt: new Date(),
			})
			// Re-granting to the same reader replaces the envelope —
			// DEK rotation (T-150 re-wrap) depends on this.
			.onConflictDoUpdate({
				target: [entityDeks.entityType, entityDeks.entityId, entityDeks.readerPubkey],
				set: { wrappedDek: grant.wrappedDek, readerId: grant.readerId ?? null },
			})
			.returning();
		written.push(rows[0]!);
	}
	return written;
}

export async function listEntityReaders(
	db: DbClient,
	tenantId: number,
	entityType: string,
	entityId: string | number,
): Promise<EntityDek[]> {
	return db
		.select()
		.from(entityDeks)
		.where(
			and(
				eq(entityDeks.tenantId, tenantId),
				eq(entityDeks.entityType, entityType),
				eq(entityDeks.entityId, String(entityId)),
			),
		);
}

/** The reader's own envelope for a record — what the client unwraps. */
export async function entityDekEnvelope(
	db: DbClient,
	tenantId: number,
	entityType: string,
	entityId: string | number,
	readerPubkey: string,
): Promise<EntityDek | null> {
	const rows = await db
		.select()
		.from(entityDeks)
		.where(
			and(
				eq(entityDeks.tenantId, tenantId),
				eq(entityDeks.entityType, entityType),
				eq(entityDeks.entityId, String(entityId)),
				eq(entityDeks.readerPubkey, readerPubkey),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

export async function revokeEntityDek(
	db: DbClient,
	tenantId: number,
	entityType: string,
	entityId: string | number,
	readerPubkey: string,
): Promise<void> {
	await db
		.delete(entityDeks)
		.where(
			and(
				eq(entityDeks.tenantId, tenantId),
				eq(entityDeks.entityType, entityType),
				eq(entityDeks.entityId, String(entityId)),
				eq(entityDeks.readerPubkey, readerPubkey),
			),
		);
}

// ── Portal device keys (T-148) ──────────────────────────────────
// Portal users are NOT tenant members, so these repo functions take no
// tenantId and no Vault-service authz: registration is self-service
// (the caller's own user id) and reader discovery is exercised through
// the doctor-side patient-access fn, which scopes the user list to
// active links of a patient the acting doctor owns.

/**
 * Register a portal user's device pubkeys — idempotent on
 * (userId, wrap pubkey); a device that re-registers (reload, retry,
 * second account on the same browser profile) gets its existing row.
 */
export async function enrollPortalDevice(
	db: DbClient,
	input: {
		readonly userId: string;
		readonly wrapPublicKey: string;
		readonly signPublicKey: string;
	},
): Promise<PortalKey> {
	const existing = await db
		.select()
		.from(portalKeys)
		.where(
			and(eq(portalKeys.userId, input.userId), eq(portalKeys.wrapPublicKey, input.wrapPublicKey)),
		)
		.limit(1);
	if (existing[0] !== undefined) return existing[0];
	const rows = await db
		.insert(portalKeys)
		.values({
			userId: input.userId,
			wrapPublicKey: input.wrapPublicKey,
			signPublicKey: input.signPublicKey,
			createdAt: new Date(),
		})
		.returning();
	return rows[0]!;
}

/** Registered portal devices of the given users — the recipient list a
 * clinic device wraps record DEKs to when it extends portal access. */
export async function portalDevicesOf(
	db: DbClient,
	userIds: readonly string[],
): Promise<PortalKey[]> {
	if (userIds.length === 0) return [];
	return db.select().from(portalKeys).where(inArray(portalKeys.userId, userIds));
}

/** The caller's own portal-device row — the read path asserts a
 * `reader_pubkey` truly belongs to the session user before handing out
 * the `entity_deks` envelope addressed to it. */
export async function portalDeviceOf(
	db: DbClient,
	userId: string,
	wrapPublicKey: string,
): Promise<PortalKey | null> {
	const rows = await db
		.select()
		.from(portalKeys)
		.where(and(eq(portalKeys.userId, userId), eq(portalKeys.wrapPublicKey, wrapPublicKey)))
		.limit(1);
	return rows[0] ?? null;
}

/** Plain read of the tenant's zk flag — `groups.zk` set by onboarding
 * or per-tenant rollout (T-143); absent group → non-ZK. */
export async function tenantIsZk(db: DbClient, tenantId: number): Promise<boolean> {
	const rows = await db
		.select({ zk: groups.zk })
		.from(groups)
		.where(eq(groups.id, tenantId))
		.limit(1);
	return rows[0]?.zk ?? false;
}

/** One-way enable of the tenant's zk flag (T-143): there is no disable
 * path — once records exist as ciphertext the clinic cannot return to
 * server-readable plaintext, so onboarding only ever sets the flag. */
export async function setTenantZk(db: DbClient, tenantId: number): Promise<void> {
	await db.update(groups).set({ zk: true }).where(eq(groups.id, tenantId));
}

/**
 * Fail-closed read of the tenant zk flag for server-composed text
 * producers (T-149): notification bodies, emails and any other copy
 * derived from record data must never embed content a ZK tenant made
 * unreadable. Unlike {@link tenantIsZk} — where an absent group means
 * "no clinic, non-ZK" — here an unresolvable tenantId (missing group
 * row or a failed lookup) answers `true`: emit metadata-only copy
 * rather than risk a PHI leak. Personal scope (null tenantId) has no
 * clinic keyring, so it stays non-ZK.
 */
export async function tenantZkOrClosed(db: DbClient, tenantId: number | null): Promise<boolean> {
	if (tenantId === null) return false;
	try {
		const rows = await db
			.select({ zk: groups.zk })
			.from(groups)
			.where(eq(groups.id, tenantId))
			.limit(1);
		return rows[0]?.zk ?? true;
	} catch {
		return true;
	}
}

/**
 * Clinic vault port (T-142, PL-007 F2): member-device enrollment +
 * approval, generic record-DEK grants, and the tenant ZK flag. The
 * service never sees key material — pubkeys and `w1.` envelopes only;
 * all wrapping/unwrapping happens in the browser via `@ktb/crypto/keyring`.
 *
 * Authz: every method requires the bound `Tenant` to BE the target
 * tenant (`tenant-mismatch` otherwise); writes and reads need
 * `member+`, device approval/revocation needs `admin+` (a member may
 * still revoke their OWN device).
 */
export class Vault extends Context.Service<
	Vault,
	{
		/** Register the caller's device — pending until an admin approves. */
		readonly enrollDevice: (input: {
			readonly tenantId: number;
			readonly wrapPublicKey: string;
			readonly signPublicKey: string;
		}) => Effect.Effect<ClinicKey, VaultError | TenantForbidden>;
		/** All member devices of the tenant (any status) — admin UI list. */
		readonly devices: (
			tenantId: number,
		) => Effect.Effect<readonly ClinicKey[], VaultError | TenantForbidden>;
		/** Approve a pending device — admin+ supplies the master key
		 * wrapped to the new device's pubkey (computed client-side). */
		readonly approveDevice: (input: {
			readonly tenantId: number;
			readonly clinicKeyId: number;
			readonly wrappedMasterKey: string;
		}) => Effect.Effect<ClinicKey, VaultError | TenantForbidden>;
		/** Revoke a device — admin+ for others, member+ for the owner's own. */
		readonly revokeDevice: (input: {
			readonly tenantId: number;
			readonly clinicKeyId: number;
		}) => Effect.Effect<ClinicKey, VaultError | TenantForbidden>;
		/** Enrollment status + master envelope for a device pubkey — the
		 * client's poll/unwrap path. Returns null when unregistered. */
		readonly deviceEnrollment: (
			tenantId: number,
			wrapPublicKey: string,
		) => Effect.Effect<ClinicKey | null, VaultError | TenantForbidden>;
		/** Store DEK envelopes for a record (create + grant paths). */
		readonly grantAccess: (input: {
			readonly tenantId: number;
			readonly entityType: string;
			readonly entityId: string | number;
			readonly grants: readonly {
				readonly readerKind: EntityDekReaderKind;
				readonly readerPubkey: string;
				readonly readerId?: string | null;
				readonly wrappedDek: string;
			}[];
		}) => Effect.Effect<readonly EntityDek[], VaultError | TenantForbidden>;
		/** Remove a reader's DEK envelope for a record. */
		readonly revokeAccess: (input: {
			readonly tenantId: number;
			readonly entityType: string;
			readonly entityId: string | number;
			readonly readerPubkey: string;
		}) => Effect.Effect<void, VaultError | TenantForbidden>;
		/** Reader list for a record — pubkey + kind + correlation id only. */
		readonly readers: (
			tenantId: number,
			entityType: string,
			entityId: string | number,
		) => Effect.Effect<readonly EntityDek[], VaultError | TenantForbidden>;
		/** The caller's wrapped DEK for a record — null when not a reader. */
		readonly dekEnvelope: (input: {
			readonly tenantId: number;
			readonly entityType: string;
			readonly entityId: string | number;
			readonly readerPubkey: string;
		}) => Effect.Effect<string | null, VaultError | TenantForbidden>;
		/** The tenant's ZK flag — `false` when the tenant is inaccessible
		 * or missing (safe default: non-ZK = today's plaintext flow). */
		readonly isZk: (tenantId: number) => Effect.Effect<boolean, VaultError>;
		/** One-way enable of the tenant's zk flag — admin+ only. No
		 * disable path: ciphertext records cannot become server-readable
		 * plaintext again, so the flag is a rollout one-way switch. */
		readonly enableZk: (tenantId: number) => Effect.Effect<void, VaultError | TenantForbidden>;
	}
>()("@ktb/vault/Vault") {}

export const VaultLive = Layer.effect(
	Vault,
	Effect.gen(function* () {
		const db = yield* Db;
		return Vault.of({
			enrollDevice: Effect.fn("Vault.enrollDevice")(function* (input) {
				yield* requireBoundTenant(input.tenantId, "member");
				const principal = yield* Principal;
				return yield* Effect.promise(() =>
					enrollClinicDevice(db, { ...input, userId: principal?.userId ?? "" }),
				);
			}),
			devices: Effect.fn("Vault.devices")(function* (tenantId) {
				yield* requireBoundTenant(tenantId, "member");
				return yield* Effect.promise(() => listClinicDevices(db, tenantId));
			}),
			approveDevice: Effect.fn("Vault.approveDevice")(function* (input) {
				yield* requireBoundTenant(input.tenantId, "admin");
				const row = yield* Effect.promise(() =>
					getClinicDevice(db, input.tenantId, input.clinicKeyId),
				);
				if (row === null) return yield* Effect.fail(new VaultError({ reason: "device-not-found" }));
				if (row.status !== "pending")
					return yield* Effect.fail(new VaultError({ reason: "device-not-pending" }));
				const principal = yield* Principal;
				return yield* Effect.promise(() =>
					approveClinicDevice(db, {
						clinicKeyId: row.id,
						wrappedMasterKey: input.wrappedMasterKey,
						approvedByUserId: principal?.userId ?? "",
					}),
				);
			}),
			revokeDevice: Effect.fn("Vault.revokeDevice")(function* (input) {
				// Self-revocation (own device lost/replaced) needs member+;
				// revoking another member's device needs admin+.
				yield* requireBoundTenant(input.tenantId, "member");
				const row = yield* Effect.promise(() =>
					getClinicDevice(db, input.tenantId, input.clinicKeyId),
				);
				if (row === null) return yield* Effect.fail(new VaultError({ reason: "device-not-found" }));
				const principal = yield* Principal;
				if (row.userId !== principal?.userId) yield* requireTenantRole("admin", "vault.admin");
				return yield* Effect.promise(() => revokeClinicDevice(db, row.id));
			}),
			deviceEnrollment: Effect.fn("Vault.deviceEnrollment")(function* (tenantId, wrapPublicKey) {
				yield* requireBoundTenant(tenantId, "member");
				return yield* Effect.promise(() => deviceByWrapPubkey(db, tenantId, wrapPublicKey));
			}),
			grantAccess: Effect.fn("Vault.grantAccess")(function* (input) {
				yield* requireBoundTenant(input.tenantId, "member");
				const principal = yield* Principal;
				return yield* Effect.promise(() =>
					grantEntityDeks(db, { ...input, grantedByUserId: principal?.userId ?? null }),
				);
			}),
			revokeAccess: Effect.fn("Vault.revokeAccess")(function* (input) {
				yield* requireBoundTenant(input.tenantId, "member");
				return yield* Effect.promise(() =>
					revokeEntityDek(db, input.tenantId, input.entityType, input.entityId, input.readerPubkey),
				);
			}),
			readers: Effect.fn("Vault.readers")(function* (tenantId, entityType, entityId) {
				yield* requireBoundTenant(tenantId, "member");
				return yield* Effect.promise(() => listEntityReaders(db, tenantId, entityType, entityId));
			}),
			dekEnvelope: Effect.fn("Vault.dekEnvelope")(function* (input) {
				yield* requireBoundTenant(input.tenantId, "member");
				const row = yield* Effect.promise(() =>
					entityDekEnvelope(
						db,
						input.tenantId,
						input.entityType,
						input.entityId,
						input.readerPubkey,
					),
				);
				return row?.wrappedDek ?? null;
			}),
			isZk: Effect.fn("Vault.isZk")(function* (tenantId) {
				// The flag itself is not sensitive, but only members of the
				// bound tenant may read it — an out-of-tenant caller gets the
				// safe default (non-ZK = today's plaintext path).
				const tenant = yield* Tenant;
				if (tenant === null || Number(tenant.id) !== tenantId) return false;
				return yield* Effect.promise(() => tenantIsZk(db, tenantId));
			}),
			enableZk: Effect.fn("Vault.enableZk")(function* (tenantId) {
				yield* requireBoundTenant(tenantId, "admin");
				yield* Effect.promise(() => setTenantZk(db, tenantId));
			}),
		});
	}),
);

// Re-exported for tests: DDL that creates clinic_keys + entity_deks +
// portal_keys in the in-memory better-sqlite3 test databases of
// instrumented plugins. `portal_keys` REFERENCES user(id) — consumers
// create their own `user` stub, so none is declared here.
export const VAULT_TEST_DDL = `
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE clinic_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE cascade, user_id TEXT NOT NULL, wrap_public_key TEXT NOT NULL, sign_public_key TEXT NOT NULL, wrapped_master_key TEXT, status TEXT NOT NULL DEFAULT 'pending', approved_by_user_id TEXT, approved_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX clinic_keys_tenant_wrap_idx ON clinic_keys (tenant_id, wrap_public_key);
CREATE INDEX clinic_keys_tenant_user_idx ON clinic_keys (tenant_id, user_id);
CREATE INDEX clinic_keys_tenant_status_idx ON clinic_keys (tenant_id, status);
CREATE TABLE entity_deks (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE cascade, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, reader_kind TEXT NOT NULL, reader_pubkey TEXT NOT NULL, reader_id TEXT, wrapped_dek TEXT NOT NULL, granted_by_user_id TEXT, created_at INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX entity_deks_record_reader_idx ON entity_deks (entity_type, entity_id, reader_pubkey);
CREATE INDEX entity_deks_tenant_record_idx ON entity_deks (tenant_id, entity_type, entity_id);
CREATE INDEX entity_deks_reader_idx ON entity_deks (reader_pubkey);
CREATE TABLE portal_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE cascade, wrap_public_key TEXT NOT NULL, sign_public_key TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX portal_keys_user_wrap_idx ON portal_keys (user_id, wrap_public_key);
CREATE INDEX portal_keys_wrap_idx ON portal_keys (wrap_public_key);
`;

export const vaultTablesPlugin = definePlugin({
	id: "vault.tables",
	meta: { keywords: ["vault", "tables"] },
	tables: { clinicKeys, entityDeks, portalKeys },
});

export const vaultServicesPlugin = definePlugin({
	id: "vault.services",
	meta: { keywords: ["vault", "services"] },
	services: VaultLive,
});

/**
 * The clinical instances the vault page mounts under, coupled by URL
 * only — the same ids the clinician plugin registers its portals with.
 * Both run loaders under the acting doctor (`subject: "doctor"`), so a
 * secretary manages the clinic vault of the doctor they act for.
 */
const CLINICAL_INSTANCES = ["doctor", "secretary"] as const;

/**
 * Clinic vault page (T-143): /portal/<doctor|secretary>/vault — key
 * onboarding (zk enable + recovery phrase) and the admin
 * device-approval surface. Dispatched inside the clinical portal
 * instances (audience + subject gates are the portal's); the loader
 * only ever reads the bound tenant's vault rows.
 */
export const vaultPagesPlugin = definePlugin({
	id: "vault.pages",
	meta: { keywords: ["vault", "ui"] },
	requiredDeps: ["vault.services"],
	pages: CLINICAL_INSTANCES.map((instance) => ({
		id: `vault.${instance}`,
		path: `/portal/${instance}/vault`,
		component: VaultClinicPage,
		loader: () =>
			Effect.gen(function* () {
				const tenant = yield* Tenant;
				const tenantId = tenantScopeId(tenant);
				if (tenant === null || tenantId === null) {
					return { tenantId: null, role: null, zk: false, devices: [] as ClinicKey[] };
				}
				const vault = yield* Vault;
				const zk = yield* vault.isZk(tenantId);
				// Role denials degrade to an empty list — a cross-tenant
				// VaultError cannot fire here (tenantId IS the bound id).
				const devices = yield* vault
					.devices(tenantId)
					.pipe(Effect.catchTag("TenantForbidden", () => Effect.succeed([] as ClinicKey[])));
				return { tenantId, role: tenant.role, zk, devices };
			}),
	})),
});

/** Sidebar entries into the clinical portals — each contribution
 * scopes itself to its own instance, so deployments without them
 * simply never render the item (no dep edge needed). */
export const vaultChromePlugin = definePlugin({
	id: "vault.chrome",
	meta: { keywords: ["vault", "ui"] },
	chrome: CLINICAL_INSTANCES.map((instance) => ({
		id: `vault.${instance}.nav`,
		region: "portal.sidebar" as const,
		portal: instance,
		content: {
			kind: "sidebarItem" as const,
			item: {
				to: `/portal/${instance}/vault`,
				label: "Vault",
				icon: KeyRoundIcon,
				group: "Clinic",
			},
		},
	})),
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	vaultTablesPlugin,
	vaultServicesPlugin,
	vaultPagesPlugin,
	vaultChromePlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"vault.tables": true;
		"vault.services": true;
		"vault.pages": true;
		"vault.chrome": true;
	}
}
