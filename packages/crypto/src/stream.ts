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
	chunkSize: number = DEFAULT_CHUNK_SIZE,
): AsyncGenerator<Uint8Array> {
	if (!Number.isInteger(chunkSize) || chunkSize <= 0)
		throw new CryptoFormatError(`invalid chunk size: ${chunkSize}`);
	yield MAGIC;
	yield u32(chunkSize);
	// Incoming iterable chunks are re-chunked to exactly `chunkSize`
	// plaintext bytes each — the header declares chunkSize and decrypt
	// rejects ctLen > chunkSize + TAG_BYTES, so the writer must never
	// emit a plaintext chunk larger than declared (an oversized input
	// chunk is split; undersized ones are coalesced).
	let buffered: Uint8Array[] = [];
	let bufferedLen = 0;
	const take = (n: number): Uint8Array => {
		const out = new Uint8Array(n);
		let o = 0;
		while (o < n) {
			const head = buffered[0]!;
			const need = n - o;
			if (head.length <= need) {
				out.set(head, o);
				o += head.length;
				buffered.shift();
			} else {
				out.set(head.subarray(0, need), o);
				buffered[0] = head.subarray(need);
				o = n;
			}
		}
		bufferedLen -= n;
		return out;
	};
	const encryptChunk = async (plain: Uint8Array): Promise<Uint8Array[]> => {
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const ct = new Uint8Array(
			await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource),
		);
		return [u32(ct.length), iv, ct];
	};
	for await (const chunk of chunks) {
		if (chunk.length === 0) continue;
		buffered.push(chunk);
		bufferedLen += chunk.length;
		while (bufferedLen >= chunkSize) {
			for (const part of await encryptChunk(take(chunkSize))) yield part;
		}
	}
	if (bufferedLen > 0) for (const part of await encryptChunk(take(bufferedLen))) yield part;
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

/** Join an encrypted stream into a single blob (e.g. one R2 object).
 * `size` is the plaintext chunk size — it is written into the KTB1
 * header, so decrypt's `ctLen <= chunkSize + TAG_BYTES` bound stays
 * honest for any value, not just the 4MiB default. */
export const encryptToBlob = async (
	key: CryptoKey,
	data: Uint8Array,
	size?: number,
): Promise<Uint8Array> =>
	concat(await collect(encryptStream(key, chunkBytes(data, size), size ?? DEFAULT_CHUNK_SIZE)));

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
