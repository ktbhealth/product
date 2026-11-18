import {
	vaultApproveDeviceFn,
	vaultEnableZkFn,
	vaultEnrollDeviceFn,
	vaultRevokeDeviceFn,
	vaultSecretPutFn,
	vaultSecretRemoveFn,
	vaultSecretRotateFn,
} from "./fns.ts";
import type { VaultApi } from "./views/index.ts";

/**
 * View-facing API adapter for the vault page (T-143): the view speaks a
 * small interface; this binds it to the plugin's server fns. Kept in
 * one module so the wiring is testable without a router.
 */
export const vaultApi: VaultApi = {
	enroll: (input) => vaultEnrollDeviceFn({ data: input }),
	approve: (input) => vaultApproveDeviceFn({ data: input }),
	revoke: (clinicKeyId) => vaultRevokeDeviceFn({ data: { clinicKeyId } }),
	enableZk: () => vaultEnableZkFn(),
	secretPut: (input) => vaultSecretPutFn({ data: input }),
	secretRotate: (id) => vaultSecretRotateFn({ data: { id } }),
	secretRemove: (id) => vaultSecretRemoveFn({ data: { id } }),
};
