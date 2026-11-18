import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Driver } from "@ktb/driver-framework";

import {
	SecretKeyring,
	SecretKeyringError,
	type SecretKeyringService,
} from "@ktb/crypto/secret-keyring";
import { aead } from "@ktb/crypto";
import { b64uToBytes, hexToBytes } from "@ktb/crypto";
import { sha256Hex } from "@ktb/crypto/digest";

/**
 * @ktb/vault-keyring — env-backed SecretKeyring driver (P-098 C1).
 *
 * `VAULT_MASTER_KEY` is a 32-byte key-encryption key encoded as hex
 * (64 chars) or base64/base64url. It wraps each secret's per-row DEK
 * (`vault_secret.wrapped_dek`); rotating the master key means
 * re-wrapping DEKs only — ciphertexts are untouched. Generate one with
 * `openssl rand -base64 32` (or `-hex 32`).
 *
 * The driver is eligible only when the env var is present — absent,
 * no SecretKeyring binds and vault secret ops fail closed. A malformed
 * key fails the layer build loudly at boot rather than at first use.
 */

const KEY_BYTES = 32;

/** Decode hex / base64 / base64url into raw bytes. */
export const decodeMasterKey = (raw: string): Uint8Array => {
	const trimmed = raw.trim();
	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return hexToBytes(trimmed);
	// Standard base64 → base64url alphabet, padding tolerated.
	const b64u = trimmed.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	try {
		return b64uToBytes(b64u);
	} catch (e) {
		throw new SecretKeyringError(
			"malformed",
			`VAULT_MASTER_KEY is not hex/base64 32-byte key material (${e instanceof Error ? e.message : String(e)})`,
		);
	}
};

const assertKey = (raw: Uint8Array): void => {
	if (raw.length !== KEY_BYTES)
		throw new SecretKeyringError(
			"malformed",
			`VAULT_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${raw.length}`,
		);
};

/** Build the service over an already-decoded KEK. Exported for tests. */
export const makeSecretKeyring = async (kekRaw: Uint8Array): Promise<SecretKeyringService> => {
	assertKey(kekRaw);
	const kek = await aead.importDek(kekRaw, ["encrypt", "decrypt"]);
	// Fingerprint only — identifies the KEK generation for rotation/audit
	// without exposing key material.
	const kekVersion = `env:${(await sha256Hex(kekRaw)).slice(0, 16)}`;
	return {
		kekVersion,
		wrapDek: async (rawDek, aad) => {
			if (rawDek.length !== KEY_BYTES)
				throw new SecretKeyringError(
					"malformed",
					`DEK must be ${KEY_BYTES} bytes, got ${rawDek.length}`,
				);
			try {
				return await aead.encrypt(kek, rawDek, aad !== undefined ? { aad } : undefined);
			} catch (e) {
				throw new SecretKeyringError(
					"unavailable",
					`wrap failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
		unwrapDek: async (wrapped, aad) => {
			try {
				const raw = await aead.decrypt(kek, wrapped, aad !== undefined ? { aad } : undefined);
				if (raw.length !== KEY_BYTES)
					throw new SecretKeyringError(
						"decrypt-failed",
						`unwrapped DEK is ${raw.length} bytes, expected ${KEY_BYTES}`,
					);
				return raw;
			} catch (e) {
				if (e instanceof SecretKeyringError) throw e;
				throw new SecretKeyringError(
					"decrypt-failed",
					`unwrap failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	};
};

/** Live layer over a master-key string — the env driver's provides()
 * and tests both build through here. */
export const secretKeyringLive = (masterKey: string) =>
	Layer.effect(
		SecretKeyring,
		Effect.gen(function* () {
			return yield* Effect.tryPromise({
				try: () => makeSecretKeyring(decodeMasterKey(masterKey)),
				catch: (e) =>
					e instanceof SecretKeyringError
						? e
						: new SecretKeyringError(
								"malformed",
								`VAULT_MASTER_KEY unusable: ${e instanceof Error ? e.message : String(e)}`,
							),
			});
		}),
	);

/** Env surface the driver inspects. */
export interface SecretKeyringEnv {
	readonly VAULT_MASTER_KEY?: string;
}

/**
 * Env driver — eligible only when VAULT_MASTER_KEY is bound. Registered
 * in app-host's driver list; absent key → vault secret ops fail closed
 * (Secrets resolves SecretKeyring via serviceOption).
 */
export const vaultKeyringEnvDriver: Driver<SecretKeyringEnv> = {
	id: "vault-keyring-env",
	port: SecretKeyring.key,
	provides: (env) =>
		typeof env.VAULT_MASTER_KEY === "string" && env.VAULT_MASTER_KEY.trim() !== ""
			? secretKeyringLive(env.VAULT_MASTER_KEY)
			: Layer.empty,
	when: (env) => typeof env.VAULT_MASTER_KEY === "string" && env.VAULT_MASTER_KEY.trim() !== "",
};
