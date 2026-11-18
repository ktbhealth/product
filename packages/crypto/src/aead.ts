import { bytesToB64u, b64uToBytes, CryptoFormatError } from "./encoding.ts";

/**
 * AES-256-GCM authenticated encryption, envelope format
 * `v1.<b64url(iv)>.<b64url(ciphertext+tag)>`. A fresh random 12-byte
 * IV per message — GCM nonce reuse is fatal, never derive it from
 * content. The version prefix lets the format rotate without a flag
 * day: old rows keep their `v1` prefix and still decrypt.
 */

export const AEAD_ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type Plaintext = string | Uint8Array;

/** Extractable so callers can wrap/export it (keyring owns wrapping). */
export const generateDek = (): Promise<CryptoKey> =>
	crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

export const importDek = (raw: Uint8Array, usages: KeyUsage[] = ["encrypt", "decrypt"]) =>
	crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, true, usages);

export const exportDek = async (key: CryptoKey): Promise<Uint8Array> =>
	new Uint8Array(await crypto.subtle.exportKey("raw", key));

export interface AeadOptions {
	/** Optional additional authenticated data — bound into the tag, never
	 * encrypted. Use it to tie a ciphertext to its row identity (e.g.
	 * `"vault-secret:7:openai-key"`) so envelopes cannot be transplanted
	 * between records. Must be identical at decrypt time. */
	readonly aad?: string | Uint8Array;
}

const gcmParams = (iv: Uint8Array, aad: AeadOptions["aad"]): AesGcmParams => {
	const params: AesGcmParams = { name: "AES-GCM", iv: iv as BufferSource };
	if (aad !== undefined) {
		params.additionalData = (typeof aad === "string" ? encoder.encode(aad) : aad) as BufferSource;
	}
	return params;
};

export const encrypt = async (
	key: CryptoKey,
	plaintext: Plaintext,
	opts?: AeadOptions,
): Promise<string> => {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const data = typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
	const ct = new Uint8Array(
		await crypto.subtle.encrypt(gcmParams(iv, opts?.aad), key, data as BufferSource),
	);
	return `${AEAD_ENVELOPE_VERSION}.${bytesToB64u(iv)}.${bytesToB64u(ct)}`;
};

export const decrypt = async (
	key: CryptoKey,
	envelope: string,
	opts?: AeadOptions,
): Promise<Uint8Array> => {
	const parts = envelope.split(".");
	if (parts.length !== 3 || parts[0] !== AEAD_ENVELOPE_VERSION)
		throw new CryptoFormatError("not a v1 AEAD envelope");
	const iv = b64uToBytes(parts[1]!);
	const ct = b64uToBytes(parts[2]!);
	if (iv.length !== IV_BYTES) throw new CryptoFormatError("bad IV length");
	return new Uint8Array(
		await crypto.subtle.decrypt(gcmParams(iv, opts?.aad), key, ct as BufferSource),
	);
};

export const decryptText = async (
	key: CryptoKey,
	envelope: string,
	opts?: AeadOptions,
): Promise<string> => decoder.decode(await decrypt(key, envelope, opts));
