import type { KeyringService } from "@ktb/crypto/keyring";
import { generateMasterKey, importRecoveryPhrase } from "@ktb/crypto/recovery";

/**
 * Browser-side clinic-vault onboarding flows (PL-007 F2, T-143): pure
 * orchestration over a `KeyringService` — the pubkeys/envelopes these
 * helpers produce are exactly what the vault server fns persist. All
 * key material stays in `crypto.subtle`; the helpers are UI-agnostic so
 * views and tests share one implementation.
 */

/** The pubkeys this device publishes to the clinic vault on enroll —
 * `w1.` envelopes wrap TO `wrapPublicKey`; `signPublicKey` verifies
 * client-signed record versions. */
export const enrollmentKeys = (
	keyring: KeyringService,
): Promise<{ readonly wrapPublicKey: string; readonly signPublicKey: string }> =>
	keyring.deviceKeys();

/**
 * First half of clinic bootstrap (admin, zk not yet enabled): a fresh
 * AES-256 master key plus its printable recovery phrase. The phrase is
 * the ONLY server-independent copy — the view shows it once and the
 * clinic stores it offline before the flow continues.
 */
export const newClinicMasterKey = generateMasterKey;

/** Wrap `masterKey` to one device's wrap pubkey — the self-wrap at
 * bootstrap and the admin re-wrap at device approval share this. */
export const wrapMasterFor = (
	keyring: KeyringService,
	masterKey: CryptoKey,
	deviceWrapPublicKey: string,
): Promise<string> => keyring.wrapKeyFor(masterKey, deviceWrapPublicKey);

/** Admin approval path: unwrap the caller's own master-key envelope
 * (their approved enrollment row) and re-wrap it to a pending device's
 * pubkey — the value `vaultApproveDeviceFn` persists. */
export const approvalEnvelope = async (
	keyring: KeyringService,
	ownWrappedMasterKey: string,
	deviceWrapPublicKey: string,
): Promise<string> =>
	keyring.wrapKeyFor(await keyring.unwrapKey(ownWrappedMasterKey), deviceWrapPublicKey);

/** Restore the clinic master key on THIS device from a recovery phrase
 * — the lost-device escape hatch. Returns the self-wrap envelope the
 * caller persists via enrollment + approval (or a fresh enrollment
 * approved by an admin, when one still exists). */
export const restoreFromPhrase = async (
	keyring: KeyringService,
	phrase: string,
): Promise<{ readonly masterKey: CryptoKey; readonly selfWrap: string }> => {
	const masterKey = await importRecoveryPhrase(phrase);
	const { wrapPublicKey } = await keyring.deviceKeys();
	return { masterKey, selfWrap: await keyring.wrapKeyFor(masterKey, wrapPublicKey) };
};
