/**
 * Isomorphic base64url — no Buffer, no btoa (this package runs in
 * browsers, workerd and Node with Web Crypto only; `node:*` imports
 * are banned by the arch policy anyway). URL-safe alphabet without
 * padding so envelopes stay safe inside JSON strings, URLs and DB
 * text columns.
 */

const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const B64U_LOOKUP = (() => {
	const table = new Int16Array(128).fill(-1);
	for (let i = 0; i < B64U_ALPHABET.length; i++) table[B64U_ALPHABET.charCodeAt(i)] = i;
	return table;
})();

export const bytesToB64u = (bytes: Uint8Array): string => {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i]!;
		const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
		const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
		const n = (b0 << 16) | (b1 << 8) | b2;
		out += B64U_ALPHABET[(n >>> 18) & 63];
		out += B64U_ALPHABET[(n >>> 12) & 63];
		out += i + 1 < bytes.length ? B64U_ALPHABET[(n >>> 6) & 63] : "";
		out += i + 2 < bytes.length ? B64U_ALPHABET[n & 63] : "";
	}
	return out;
};

export const b64uToBytes = (input: string): Uint8Array => {
	if (input.length === 0) return new Uint8Array(0);
	if (input.length % 4 === 1) throw new CryptoFormatError("invalid base64url length");
	const rem = input.length % 4;
	const out = new Uint8Array(Math.floor(input.length / 4) * 3 + (rem === 0 ? 0 : rem - 1));
	let o = 0;
	for (let i = 0; i < input.length; i += 4) {
		const chunk = input.length - i < 4 ? input.length - i : 4;
		let n = 0;
		for (let j = 0; j < chunk; j++) {
			const v = B64U_LOOKUP[input.charCodeAt(i + j)];
			if (v === undefined || v < 0) throw new CryptoFormatError("invalid base64url character");
			n |= v << (18 - 6 * j);
		}
		out[o++] = (n >>> 16) & 255;
		if (chunk > 2) out[o++] = (n >>> 8) & 255;
		if (chunk > 3) out[o++] = n & 255;
	}
	return out;
};

export const bytesToHex = (bytes: Uint8Array): string => {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
};

export const hexToBytes = (hex: string): Uint8Array => {
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex))
		throw new CryptoFormatError("invalid hex string");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
};

/** Malformed ciphertext/envelope/key material — thrown before any
 * subtle call so callers can distinguish format errors from auth
 * failures (Web Crypto throws its own DOMException on bad tags). */
export class CryptoFormatError extends Error {
	readonly _tag = "CryptoFormatError";
	constructor(message: string) {
		super(message);
		this.name = "CryptoFormatError";
	}
}
