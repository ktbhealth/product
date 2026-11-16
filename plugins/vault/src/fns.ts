import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { ensureSessionUser, getSessionUser, runAs } from "@ktb/server-fns";
import { Tenant, TenantForbidden, tenantScopeId } from "@ktb/tenant";

import { Vault, type ClinicKey } from "./index.ts";

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

const decodePubkeys = Schema.decodeUnknownSync(PubkeysInput);
const decodeEnrollment = Schema.decodeUnknownSync(EnrollmentInput);
const decodeDeviceId = Schema.decodeUnknownSync(DeviceIdInput);
const decodeApprove = Schema.decodeUnknownSync(ApproveInput);

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

/** Denials collapse to `{ ok: false }` — same convention as the other
 * tenant-scoped fns; unexpected errors still propagate. */
const denyToFalse = <A>(fallback: A) =>
	Effect.catchTags({
		VaultError: () => Effect.succeed(fallback),
		TenantForbidden: () => Effect.succeed(fallback),
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
