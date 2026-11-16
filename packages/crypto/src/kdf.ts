/**
 * Key derivation, Web Crypto only. PBKDF2-SHA-256 at OWASP floor
 * iterations for passphrase→key (generic primitive — the clinic
 * recovery path encodes the key material itself, it is not
 * passphrase-derived). HKDF-SHA-256 for purpose subkeys.
 */

const encoder = new TextEncoder();

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;

const importPassphrase = (passphrase: string, usages: KeyUsage[]) =>
	crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, usages);

/** Passphrase → AES-256-GCM key (e.g. passphrase-protecting a stored
 * wrapped key). */
export const pbkdf2ToAesKey = async (
	passphrase: string,
	salt: Uint8Array,
	iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> =>
	crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
		await importPassphrase(passphrase, ["deriveKey"]),
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);

/** Passphrase → raw bytes (deterministic; used in tests against the
 * RFC 6070-style vector). */
export const pbkdf2Bytes = async (
	passphrase: string,
	salt: Uint8Array,
	iterations: number,
	byteLength: number,
): Promise<Uint8Array> =>
	new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
			await importPassphrase(passphrase, ["deriveBits"]),
			byteLength * 8,
		),
	);

export const generateSalt = (): Uint8Array => crypto.getRandomValues(new Uint8Array(SALT_BYTES));

/** HKDF-SHA-256 → raw bytes. `info` binds the output to a purpose. */
export const hkdfBytes = async (
	keyMaterial: Uint8Array,
	salt: Uint8Array,
	info: string,
	byteLength: number,
): Promise<Uint8Array> =>
	new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "HKDF", salt: salt as BufferSource, info: encoder.encode(info), hash: "SHA-256" },
			await crypto.subtle.importKey("raw", keyMaterial as BufferSource, "HKDF", false, [
				"deriveBits",
			]),
			byteLength * 8,
		),
	);

/** HKDF-SHA-256 → AES-256-GCM key bound to a purpose string. */
export const hkdfToAesKey = async (
	keyMaterial: Uint8Array,
	salt: Uint8Array,
	info: string,
): Promise<CryptoKey> => {
	const material = await crypto.subtle.importKey(
		"raw",
		keyMaterial as BufferSource,
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", salt: salt as BufferSource, info: encoder.encode(info), hash: "SHA-256" },
		material,
		{ name: "AES-GCM", length: 256 },
		true,
		["encrypt", "decrypt"],
	);
};
