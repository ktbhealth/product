import { bytesToB64u, b64uToBytes, CryptoFormatError } from "./encoding.ts";
import { hkdfToAesKey } from "./kdf.ts";
import { importDek, exportDek, encrypt, decrypt } from "./aead.ts";

/**
 * ECIES-style DEK wrapping over Web Crypto primitives. A DEK is
 * wrapped FOR a recipient key pair: an ephemeral ECDH P-256 pair is
 * generated per wrap, ECDH(ephemeral, recipientPub) feeds
 * HKDF-SHA-256 (info "ktb.dek-wrap.v1") into an AES-256-GCM KEK, and
 * the DEK's raw bytes are encrypted under it. Blob format:
 * `w1.<b64url(ephemeralPub)>.<b64url(iv)>.<b64url(ct)>`.
 *
 * The recipient unwraps with only their private key — the sender's
 * identity is not authenticated by this primitive (bind it in the
 * surrounding protocol if needed).
 */

export const WRAP_VERSION = "w1";
const WRAP_INFO = "ktb.dek-wrap.v1";
const EMPTY_SALT = new Uint8Array(0);

export const generateWrapKeyPair = (): Promise<CryptoKeyPair> =>
	crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);

export const exportWrapPublicKey = async (key: CryptoKey): Promise<string> =>
	bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("raw", key)));

export const exportWrapPrivateKey = async (key: CryptoKey): Promise<string> =>
	bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)));

export const importWrapPublicKey = (b64: string, extractable = true): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"raw",
		b64uToBytes(b64) as BufferSource,
		{ name: "ECDH", namedCurve: "P-256" },
		extractable,
		[],
	);

export const importWrapPrivateKey = (b64: string, extractable = true): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"pkcs8",
		b64uToBytes(b64) as BufferSource,
		{ name: "ECDH", namedCurve: "P-256" },
		extractable,
		["deriveBits"],
	);

const deriveKek = (privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> =>
	crypto.subtle
		.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)
		.then((bits) => hkdfToAesKey(new Uint8Array(bits), EMPTY_SALT, WRAP_INFO));

/** Wrap a DEK for a recipient public key. Random ephemeral pair per
 * call — two wraps of the same DEK produce different blobs. */
export const wrapDek = async (dek: CryptoKey, recipientPublicKey: CryptoKey): Promise<string> => {
	const ephemeral = await generateWrapKeyPair();
	const kek = await deriveKek(ephemeral.privateKey, recipientPublicKey);
	const envelope = await encrypt(kek, await exportDek(dek));
	const ephPub = bytesToB64u(
		new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)),
	);
	return `${WRAP_VERSION}.${ephPub}.${envelope.split(".").slice(1).join(".")}`;
};

/** Unwrap a `w1` blob with the recipient's private key → usable DEK. */
export const unwrapDek = async (
	blob: string,
	recipientPrivateKey: CryptoKey,
): Promise<CryptoKey> => {
	const parts = blob.split(".");
	if (parts.length !== 4 || parts[0] !== WRAP_VERSION)
		throw new CryptoFormatError("not a w1 wrapped-key blob");
	const ephemeralPub = await importWrapPublicKey(parts[1]!);
	const kek = await deriveKek(recipientPrivateKey, ephemeralPub);
	const raw = await decrypt(kek, `v1.${parts[2]}.${parts[3]}`);
	if (raw.length !== 32) throw new CryptoFormatError("wrapped payload is not a 256-bit key");
	return importDek(raw);
};
