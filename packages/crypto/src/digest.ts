import { bytesToHex, hexToBytes, CryptoFormatError } from "./encoding.ts";

/**
 * SHA-256 digests + canonical JSON. `contentHash` is the legal
 * integrity primitive: the hash is always computed over the
 * canonical serialization of the PARSED document — never over the
 * raw stored string, whose key order depends on whatever produced
 * the JSON. Canon: object keys sorted recursively (code-point
 * order), arrays keep order, undefined/function-valued properties
 * dropped like JSON, output normalized to NFC.
 */

const encoder = new TextEncoder();

export const sha256 = async (data: Uint8Array | string): Promise<Uint8Array> =>
	new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			(typeof data === "string" ? encoder.encode(data) : data) as BufferSource,
		),
	);

export const sha256Hex = async (data: Uint8Array | string): Promise<string> =>
	bytesToHex(await sha256(data));

const sortValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined && typeof v !== "function")
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([k, v]) => [k, sortValue(v)]),
		);
	}
	return value;
};

export const canonicalize = (value: unknown): string =>
	JSON.stringify(sortValue(value)).normalize("NFC");

/** SHA-256 hex of the canonical document — the content_hash stored
 * on document_versions rows. */
export const contentHash = (value: unknown): Promise<string> => sha256Hex(canonicalize(value));

/** Recompute content_hash over a parsed document and compare to the
 * stored hex — integrity verification for readers. */
export const verifyContentHash = async (value: unknown, expectedHex: string): Promise<boolean> => {
	try {
		const computed = await contentHash(value);
		return computed === expectedHex.toLowerCase();
	} catch {
		return false;
	}
};

export { hexToBytes, CryptoFormatError };
