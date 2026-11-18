import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { ensureSessionUser, getSessionUser, runAs } from "@ktb/server-fns";
import { Tenant, tenantScopeId } from "@ktb/tenant";

import { Vault, type ClinicKey } from "./index.ts";
import { Secrets, type SecretMeta } from "./secrets.ts";

// Clinic vault server functions (PL-007 F2, T-143): device enrollment,
// admin approval/revocation and the one-way zk enable switch. Every fn
// scopes by the BOUND tenant (x-tenant-* headers → TenantResolver —
// never a client-supplied id): the caller can only ever touch the
// clinic their request resolved to. The Vault service re-checks
// bound-tenant == target and the member/admin role inside.
//
// Wire payloads carry only pubkeys and `w1.` envelopes — the server
// never sees key material; wrapping happens in the browser via
// @ktb/crypto/keyring (+ ./onboarding.ts helpers).

const PubkeysInput = Schema.Struct({
	wrapPublicKey: Schema.NonEmptyString,
	signPublicKey: Schema.NonEmptyString,
});
const EnrollmentInput = Schema.Struct({ wrapPublicKey: Schema.NonEmptyString });
const DeviceIdInput = Schema.Struct({ clinicKeyId: Schema.Number });
const ApproveInput = Schema.Struct({
	clinicKeyId: Schema.Number,
	wrappedMasterKey: Schema.NonEmptyString,
});
/** entityId rides the wire as number|string — the service stringifies. */
const EntityId = Schema.Union([Schema.Number, Schema.NonEmptyString]);
const GrantsInput = Schema.Struct({
	entityType: Schema.NonEmptyString,
	entityId: EntityId,
	grants: Schema.Array(
		Schema.Struct({
			readerKind: Schema.Literals(["device", "patient"]),
			readerPubkey: Schema.NonEmptyString,
			readerId: Schema.optionalKey(Schema.NullishOr(Schema.String)),
			wrappedDek: Schema.NonEmptyString,
		}),
	),
});
const DekEnvelopesInput = Schema.Struct({
	entityType: Schema.NonEmptyString,
	entityIds: Schema.Array(EntityId),
	wrapPublicKey: Schema.NonEmptyString,
});

const decodePubkeys = Schema.decodeUnknownSync(PubkeysInput);
const decodeEnrollment = Schema.decodeUnknownSync(EnrollmentInput);
const decodeDeviceId = Schema.decodeUnknownSync(DeviceIdInput);
const decodeApprove = Schema.decodeUnknownSync(ApproveInput);
const decodeGrants = Schema.decodeUnknownSync(GrantsInput);
const decodeDekEnvelopes = Schema.decodeUnknownSync(DekEnvelopesInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

/** Denials collapse to `{ ok: false }` — same convention as the other
 * tenant-scoped fns; unexpected errors still propagate. */
const denyToFalse = <A>(fallback: A) =>
	Effect.catchTags({
		VaultError: () => Effect.succeed(fallback),
		TenantForbidden: () => Effect.succeed(fallback),
		SecretError: () => Effect.succeed(fallback),
		Forbidden: () => Effect.succeed(fallback),
	});

/** Bound-tenant id or null — personal scope has no clinic vault. */
const boundTenantId = Effect.map(Tenant, tenantScopeId);

/**
 * What the vault page needs to render: the resolved tenant's id, the
 * caller's tenant role (drives admin controls) and the zk flag. Null
 * fields mark personal scope — ZK requires a clinic tenant.
 */
export const vaultStateFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<{
		readonly tenantId: number | null;
		readonly role: string | null;
		readonly zk: boolean;
	}> => {
		const user = await getSessionUser();
		if (!user) return { tenantId: null, role: null, zk: false };
		return runAs(
			user,
			Effect.gen(function* () {
				const tenant = yield* Tenant;
				const tenantId = tenantScopeId(tenant);
				if (tenant === null || tenantId === null) {
					return { tenantId: null, role: null, zk: false };
				}
				const vault = yield* Vault;
				const zk = yield* vault.isZk(tenantId);
				return { tenantId, role: tenant.role, zk };
			}),
		);
	},
);

/** Member devices of the bound tenant (any status) — the admin list. */
export const vaultDevicesFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly ClinicKey[]> => {
		const user = await getSessionUser();
		if (!user) return [];
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return [] as ClinicKey[];
				const vault = yield* Vault;
				return yield* vault.devices(tenantId).pipe(denyToFalse([] as ClinicKey[]));
			}),
		);
	},
);

/** The caller's own device row by wrap pubkey — enrollment status plus
 * the `wrappedMasterKey` envelope only this device can unwrap. */
export const vaultEnrollmentFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeEnrollment(input))
	.handler(async ({ data }): Promise<ClinicKey | null> => {
		const user = await getSessionUser();
		if (!user) return null;
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return null;
				const vault = yield* Vault;
				return yield* vault.deviceEnrollment(tenantId, data.wrapPublicKey).pipe(denyToFalse(null));
			}),
		);
	});

/** Register this device's pubkeys — pending until an admin approves. */
export const vaultEnrollDeviceFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodePubkeys(input))
	.handler(async ({ data }): Promise<Result<ClinicKey>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return { ok: false as const };
				const vault = yield* Vault;
				return yield* vault.enrollDevice({ tenantId, ...data }).pipe(
					Effect.map((device) => ({ ok: true as const, data: device })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

/** Approve a pending device — admin+; `wrappedMasterKey` is the clinic
 * master key wrapped to THAT device's pubkey, computed client-side. */
export const vaultApproveDeviceFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeApprove(input))
	.handler(async ({ data }): Promise<Result<ClinicKey>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return { ok: false as const };
				const vault = yield* Vault;
				return yield* vault.approveDevice({ tenantId, ...data }).pipe(
					Effect.map((device) => ({ ok: true as const, data: device })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

/** Revoke a device — admin+ for others, member+ for the owner's own. */
export const vaultRevokeDeviceFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeDeviceId(input))
	.handler(async ({ data }): Promise<Result<ClinicKey>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return { ok: false as const };
				const vault = yield* Vault;
				return yield* vault.revokeDevice({ tenantId, clinicKeyId: data.clinicKeyId }).pipe(
					Effect.map((device) => ({ ok: true as const, data: device })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

/**
 * Record DEK grants (T-144): the client wraps a record's DEK to each
 * authorized reader pubkey and POSTs only the `w1.` envelopes —
 * `readerKind` is "device" (clinic members) or "patient" (portal).
 */
export const vaultGrantAccessFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeGrants(input))
	.handler(async ({ data }) => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return { ok: false as const };
				const vault = yield* Vault;
				return yield* vault.grantAccess({ tenantId, ...data }).pipe(
					Effect.map((rows) => ({ ok: true as const, data: rows })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

/**
 * The caller's wrapped DEK envelopes for a batch of records, keyed by
 * entityId — one round-trip for a whole list page (T-144). Records the
 * caller cannot read are simply absent from the map.
 */
export const vaultDekEnvelopesFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeDekEnvelopes(input))
	.handler(async ({ data }): Promise<Record<string, string>> => {
		const user = await getSessionUser();
		if (!user) return {};
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return {};
				const vault = yield* Vault;
				const out: Record<string, string> = {};
				for (const entityId of data.entityIds) {
					const envelope = yield* vault
						.dekEnvelope({
							tenantId,
							entityType: data.entityType,
							entityId,
							readerPubkey: data.wrapPublicKey,
						})
						.pipe(denyToFalse(null));
					if (envelope !== null) out[String(entityId)] = envelope;
				}
				return out;
			}),
		);
	});

/** One-way zk enable for the bound tenant — admin+ (T-143). */
export const vaultEnableZkFn = createServerFn({ method: "POST" }).handler(
	async (): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return { ok: false as const };
				const vault = yield* Vault;
				return yield* vault
					.enableZk(tenantId)
					.pipe(Effect.as({ ok: true as const, data: null }), denyToFalse({ ok: false as const }));
			}),
		);
	},
);

// ── Server-side secrets (P-098 C2) ────────────────────────────────
//
// Tenant-scoped credential management: the bound tenant IS the scope —
// a caller can only ever list/write secrets of the clinic their
// request resolved to (never a client-supplied tenant id). Platform
// scope (`tenantId: null`) is deliberately NOT reachable here — it is
// platform-admin territory and gets its own console surface.
//
// Wire safety: `put` accepts the plaintext value once (it is sealed
// server-side and never echoed back); every read returns SecretMeta —
// metadata only, no ciphertext, no DEK material. `resolve` is never
// exposed over the wire: it is a server-side port for drivers.

const SecretKindLiterals = Schema.Literals(["api-key", "token", "password", "pem", "generic"]);
const SecretPutInput = Schema.Struct({
	name: Schema.NonEmptyString,
	value: Schema.NonEmptyString,
	provider: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	kind: Schema.optionalKey(SecretKindLiterals),
});
const SecretIdInput = Schema.Struct({ id: Schema.Number });

const decodeSecretPut = Schema.decodeUnknownSync(SecretPutInput);
const decodeSecretId = Schema.decodeUnknownSync(SecretIdInput);

/** Secret metadata for the bound tenant — members may list. */
export const vaultSecretsListFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly SecretMeta[]> => {
		const user = await getSessionUser();
		if (!user) return [];
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return [] as SecretMeta[];
				const secrets = yield* Secrets;
				return yield* secrets.list({ tenantId }).pipe(
					Effect.catchTags({
						SecretError: () => Effect.succeed([] as SecretMeta[]),
						TenantForbidden: () => Effect.succeed([] as SecretMeta[]),
						Forbidden: () => Effect.succeed([] as SecretMeta[]),
					}),
				);
			}),
		);
	},
);

/** Create or rotate-by-name a tenant secret — admin+ (service gate). */
export const vaultSecretPutFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSecretPut(input))
	.handler(async ({ data }): Promise<Result<SecretMeta>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const tenantId = yield* boundTenantId;
				if (tenantId === null) return { ok: false as const };
				const secrets = yield* Secrets;
				return yield* secrets.put({ tenantId, ...data }).pipe(
					Effect.map((meta) => ({ ok: true as const, data: meta })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

/** Re-wrap the DEK + re-encrypt the current value — admin+ (service gate). */
export const vaultSecretRotateFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSecretId(input))
	.handler(async ({ data }): Promise<Result<SecretMeta>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const secrets = yield* Secrets;
				return yield* secrets.rotate({ id: data.id }).pipe(
					Effect.map((meta) => ({ ok: true as const, data: meta })),
					denyToFalse({ ok: false as const }),
				);
			}),
		);
	});

/** Hard-delete a secret row — admin+ (service gate). */
export const vaultSecretRemoveFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeSecretId(input))
	.handler(async ({ data }): Promise<Result<null>> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const secrets = yield* Secrets;
				return yield* secrets
					.remove({ id: data.id })
					.pipe(Effect.as({ ok: true as const, data: null }), denyToFalse({ ok: false as const }));
			}),
		);
	});
