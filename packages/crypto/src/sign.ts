import { bytesToB64u, b64uToBytes } from "./encoding.ts";

/**
 * ECDSA P-256 / SHA-256 signatures — the clinic signs document
 * content_hashes client-side so a stored version is non-repudiable
 * without the server holding any key. Web Crypto emits the
 * (r || s) raw signature form, which is what we store.
 */

export const generateSignKeyPair = (): Promise<CryptoKeyPair> =>
	crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

export const exportSignPublicKey = async (key: CryptoKey): Promise<string> =>
	bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("raw", key)));

export const exportSignPrivateKey = async (key: CryptoKey): Promise<string> =>
	bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)));

export const importSignPublicKey = (b64: string): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"raw",
		b64uToBytes(b64) as BufferSource,
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["verify"],
	);

export const importSignPrivateKey = (b64: string): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"pkcs8",
		b64uToBytes(b64) as BufferSource,
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign"],
	);

const encoder = new TextEncoder();

export const sign = async (privateKey: CryptoKey, data: string | Uint8Array): Promise<string> => {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	const sig = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		privateKey,
		bytes as BufferSource,
	);
	return bytesToB64u(new Uint8Array(sig));
};

export const verify = async (
	publicKey: CryptoKey,
	data: string | Uint8Array,
	signatureB64: string,
): Promise<boolean> => {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	return crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		publicKey,
		b64uToBytes(signatureB64) as BufferSource,
		bytes as BufferSource,
	);
};
