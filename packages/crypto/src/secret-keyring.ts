import * as Context from "effect/Context";

/**
 * SecretKeyring port (P-098 C1): the key-wrap boundary for server-side
 * secret storage (plugins/vault `vault_secret`). Consumers generate a
 * fresh AES-256 DEK per secret, store the DEK only as a wrapped
 * envelope, and wrap/unwrap through this port — the KEK itself never
 * leaves the driver.
 *
 * Promise-shaped like {@link EntityCipher}: impls live in driver
 * packages (`@ktb/vault-keyring` reads `VAULT_MASTER_KEY`); consumers
 * resolve via `Effect.serviceOption(SecretKeyring)` and fail closed
 * when no driver is bound.
 *
 * `aad` binds the wrapped-DEK envelope to its secret identity
 * (scope + name) so envelopes cannot be transplanted between rows —
 * it must be identical at wrap and unwrap time.
 */
export interface SecretKeyringService {
	/** Wrap a raw 32-byte DEK under the key-encryption key. */
	readonly wrapDek: (rawDek: Uint8Array, aad?: string) => Promise<string>;
	/** Unwrap a stored DEK envelope back to its raw 32 bytes. */
	readonly unwrapDek: (wrapped: string, aad?: string) => Promise<Uint8Array>;
	/** KEK identity for rotation/audit — e.g. a fingerprint of the
	 * master key material, never the key itself. */
	readonly kekVersion: string;
}

export class SecretKeyring extends Context.Service<SecretKeyring, SecretKeyringService>()(
	"@ktb/crypto/SecretKeyring",
) {}

/** Env slice read by SecretKeyring drivers (mirrors app-host AppEnv). */
export interface SecretKeyringEnv {
	readonly VAULT_MASTER_KEY?: string;
}

/** Thrown by drivers on malformed key material or unwrap failures —
 * drivers may also let `CryptoFormatError` propagate. */
export class SecretKeyringError extends Error {
	readonly reason: "unavailable" | "malformed" | "decrypt-failed";
	constructor(reason: SecretKeyringError["reason"], message?: string) {
		super(message ?? `secret keyring ${reason}`);
		this.name = "SecretKeyringError";
		this.reason = reason;
	}
}
