import { CryptoFormatError } from "./encoding.ts";

/**
 * Chunked AES-256-GCM for large blobs (audio). Binary framing:
 *
 *   "KTB1" (4B magic) || u32le chunkSize
 *   [ u32le ctLen || iv(12B) || ct(ctLen) ]+  per chunk, random IV
 *   u32le 0                                 terminator — truncating
 *                                           the tail is detectable
 *
 * Each chunk is independently authenticated; a tampered or dropped
 * middle chunk fails its GCM tag and the terminator guards tail
 * truncation. Streams in and out so the whole blob never has to be
 * in memory.
 */

const MAGIC = new Uint8Array([0x4b, 0x54, 0x42, 0x31]); // "KTB1"
const IV_BYTES = 12;
const TAG_BYTES = 16;

const encoder = new TextEncoder();

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

const u32 = (n: number): Uint8Array => {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n, true);
	return b;
};

const readU32 = (view: DataView, offset: number): number => view.getUint32(offset, true);

export async function* encryptStream(
	key: CryptoKey,
	chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
	yield MAGIC;
	yield u32(DEFAULT_CHUNK_SIZE);
	for await (const chunk of chunks) {
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const ct = new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, chunk as BufferSource),
		);
		yield u32(ct.length);
		yield iv;
		yield ct;
	}
	yield u32(0);
}

/** Split a flat Uint8Array into fixed-size chunks (convenience for
 * in-memory callers like tests and small files). */
export async function* chunkBytes(
	data: Uint8Array,
	size: number = DEFAULT_CHUNK_SIZE,
): AsyncGenerator<Uint8Array> {
	for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

/** Join an encrypted stream into a single blob (e.g. one R2 object). */
export const encryptToBlob = async (
	key: CryptoKey,
	data: Uint8Array,
	size?: number,
): Promise<Uint8Array> => concat(await collect(encryptStream(key, chunkBytes(data, size))));

/** Decrypt a single framed blob back to bytes. */
export const decryptBlob = async (key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> => {
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	if (blob.length < 8 || !MAGIC.every((b, i) => blob[i] === b))
		throw new CryptoFormatError("not a KTB1 framed blob");
	const chunkSize = readU32(view, 4);
	let offset = 8;
	const out: Uint8Array[] = [];
	for (;;) {
		if (offset + 4 > blob.length) throw new CryptoFormatError("missing terminator");
		const ctLen = readU32(view, offset);
		offset += 4;
		if (ctLen === 0) break;
		if (ctLen > chunkSize + TAG_BYTES)
			throw new CryptoFormatError("chunk exceeds declared chunk size");
		if (offset + IV_BYTES + ctLen > blob.length) throw new CryptoFormatError("truncated chunk");
		const iv = blob.subarray(offset, offset + IV_BYTES);
		offset += IV_BYTES;
		const ct = blob.subarray(offset, offset + ctLen);
		offset += ctLen;
		out.push(
			new Uint8Array(
				await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv: iv as BufferSource },
					key,
					ct as BufferSource,
				),
			),
		);
	}
	return concat(out);
};

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
	const out: T[] = [];
	for await (const item of it) out.push(item);
	return out;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};

/** Encrypt a UTF-8 string through the blob path (test helper parity
 * with plaintext callers). */
export const encryptTextToBlob = async (key: CryptoKey, text: string): Promise<Uint8Array> =>
	encryptToBlob(key, encoder.encode(text));

export const decryptBlobText = async (key: CryptoKey, blob: Uint8Array): Promise<string> =>
	new TextDecoder().decode(await decryptBlob(key, blob));
