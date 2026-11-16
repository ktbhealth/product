import * as Layer from "effect/Layer";
import type { Driver } from "@ktb/driver-framework";

import {
	EntityCipher,
	type CipherDriverEnv,
	type CipherRow,
	type CipherSpec,
	type EntityCipherService,
} from "@ktb/crypto/cipher";
import { CryptoFormatError } from "@ktb/crypto";

/**
 * Passthrough EntityCipher for non-ZK deployments (T-140): rows persist
 * exactly as today — no field becomes ciphertext. The spec contract is
 * still enforced (undeclared keys throw `CryptoFormatError`), so a
 * record classified wrong in a spec fails identically under both impls.
 * Real per-tenant DEK impls land with the vault plugin (PL-007 F2).
 */
const passthrough = async (_spec: CipherSpec, _dek: CryptoKey, row: CipherRow) => {
	for (const key of Object.keys(row)) {
		if (!_spec.fields.includes(key) && !_spec.plaintext.includes(key)) {
			throw new CryptoFormatError(
				`cipher spec ${_spec.entity}: undeclared field "${key}" — every persisted key must be classified`,
			);
		}
	}
	return { ...row };
};

export const makePassthroughCipher = (): EntityCipherService => ({
	encryptRow: passthrough,
	decryptRow: passthrough,
	encryptPatch: passthrough,
});

/** Live layer: the non-ZK default binding. */
export const EntityCipherStubLive = Layer.succeed(EntityCipher, makePassthroughCipher());

/**
 * Always-eligible driver — the passthrough is the deployment default
 * until a real keyring-backed driver exists. Kept LAST in the app-host
 * driver list once ZK drivers arrive (first eligible wins).
 */
export const passthroughCipherDriver: Driver<CipherDriverEnv> = {
	id: "cipher-passthrough",
	port: EntityCipher.key,
	provides: () => EntityCipherStubLive,
	when: () => true,
};
