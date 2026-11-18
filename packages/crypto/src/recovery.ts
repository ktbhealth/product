import { generateDek, importDek } from "./aead.ts";
import { CryptoFormatError } from "./encoding.ts";
import { sha256Hex } from "./digest.ts";

/**
 * Clinic master-key recovery phrase (PL-007 F2, T-143): the clinic's
 * root AES-256 key, encoded for humans — a printable, speakable
 * string the clinic writes down or prints at onboarding. Lost key =
 * lost data; the phrase is the only server-independent copy.
 *
 * Wire format: `keyBytes(32) || checksum(1)` → RFC 4648 base32,
 * lowercase, no padding → grouped in 4-char blocks joined by dashes.
 * 33 bytes → 53 chars → "xxxx-xxxx-…-x" (14 blocks). Checksum = first
 * byte of SHA-256(keyBytes) — catches transcription slips before the
 * phrase is trusted. Decoding accepts any separator/casing.
 */

const B32 = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 alphabet, lowercase

const KEY_BYTES = 32;

const b32Encode = (bytes: Uint8Array): string => {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	/* v8 ignore next -- the tail flush is unreachable: b32Encode only ever
	   encodes the fixed 33-byte payload, whose bit count never lands on a
	   5-bit boundary. */
	// stryker disable next-line all
	if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
	return out;
};

const b32Decode = (text: string): Uint8Array => {
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const ch of text) {
		const value = B32.indexOf(ch);
		if (value < 0) throw new CryptoFormatError("recovery phrase has an invalid character");
		buffer = (buffer << 5) | value;
		bits += 5;
		if (bits >= 8) {
			bytes.push((buffer >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	// Non-zero leftover bits would mean the input wasn't byte-aligned —
	// padding-less base32 of whole bytes never produces them.
	if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0)
		throw new CryptoFormatError("recovery phrase is truncated");
	return new Uint8Array(bytes);
};

const hexByte = (hex: string, at: number): number => parseInt(hex.slice(at * 2, at * 2 + 2), 16);

/** A fresh clinic master key (AES-256-GCM, extractable — it must be
 * phrase-encodable and wrappable) plus its printable recovery phrase. */
export const generateMasterKey = async (): Promise<{
	readonly key: CryptoKey;
	readonly phrase: string;
}> => {
	const key = await generateDek();
	return { key, phrase: await encodeRecoveryPhrase(key) };
};

/** Encode a master key (or its raw 32 bytes) as the recovery phrase. */
export const encodeRecoveryPhrase = async (key: CryptoKey | Uint8Array): Promise<string> => {
	const raw =
		key instanceof Uint8Array ? key : new Uint8Array(await crypto.subtle.exportKey("raw", key));
	if (raw.length !== KEY_BYTES) throw new CryptoFormatError("master key is not 256 bits");
	const checksum = hexByte(await sha256Hex(raw), 0);
	const payload = new Uint8Array(KEY_BYTES + 1);
	payload.set(raw);
	payload[KEY_BYTES] = checksum;
	const encoded = b32Encode(payload);
	return encoded.match(/.{1,4}/g)!.join("-");
};

/** Decode a recovery phrase → raw 32 key bytes; throws on bad
 * checksum/length — a mistyped phrase must fail loudly, not unwrap. */
export const decodeRecoveryPhrase = async (phrase: string): Promise<Uint8Array> => {
	// Only separators are forgiving — anything outside the alphabet is
	// an invalid character, not something to silently drop.
	const normalized = phrase.toLowerCase().replace(/[\s\-_/]+/g, "");
	const payload = b32Decode(normalized);
	if (payload.length !== KEY_BYTES + 1)
		throw new CryptoFormatError("recovery phrase has the wrong length");
	const keyBytes = payload.slice(0, KEY_BYTES);
	if (hexByte(await sha256Hex(keyBytes), 0) !== payload[KEY_BYTES])
		throw new CryptoFormatError("recovery phrase checksum mismatch");
	return keyBytes;
};

/** Recovery phrase → a usable master CryptoKey. */
export const importRecoveryPhrase = async (phrase: string): Promise<CryptoKey> =>
	importDek(await decodeRecoveryPhrase(phrase));
