import { describe, expect, it } from "vitest";

import { generateDek } from "./aead.ts";
import { CryptoFormatError } from "./encoding.ts";
import {
	chunkBytes,
	decryptBlob,
	decryptBlobText,
	DEFAULT_CHUNK_SIZE,
	encryptStream,
	encryptTextToBlob,
	encryptToBlob,
} from "./stream.ts";

const encoder = new TextEncoder();
const MAGIC = new Uint8Array([0x4b, 0x54, 0x42, 0x31]); // "KTB1"

const u32 = (n: number): Uint8Array => {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n, true);
	return b;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
	const out: T[] = [];
	for await (const item of it) out.push(item);
	return out;
};

describe("chunked AES-GCM blob (KTB1)", () => {
	it("round-trips a multi-chunk payload", async () => {
		const key = await generateDek();
		const data = crypto.getRandomValues(new Uint8Array(10_000));
		const blob = await encryptToBlob(key, data, 1024);
		expect(blob.subarray(0, 4)).toEqual(MAGIC);
		expect(await decryptBlob(key, blob)).toEqual(data);
	});

	it("round-trips a payload smaller than one chunk (default size)", async () => {
		const key = await generateDek();
		const data = crypto.getRandomValues(new Uint8Array(100));
		const blob = await encryptToBlob(key, data);
		expect(await decryptBlob(key, blob)).toEqual(data);
	});

	it("round-trips an empty payload", async () => {
		const key = await generateDek();
		const blob = await encryptToBlob(key, new Uint8Array(0));
		expect(blob.length).toBe(12); // magic + chunkSize + terminator
		expect(await decryptBlob(key, blob)).toEqual(new Uint8Array(0));
	});

	it("round-trips text via the convenience helpers", async () => {
		const key = await generateDek();
		const blob = await encryptTextToBlob(key, "transcrição do áudio");
		expect(await decryptBlobText(key, blob)).toBe("transcrição do áudio");
	});

	it("emits the documented frame structure", async () => {
		const key = await generateDek();
		const chunk = crypto.getRandomValues(new Uint8Array(100));
		async function* one() {
			yield chunk;
		}
		const parts = await collect(encryptStream(key, one()));
		// magic, chunkSize, ctLen, iv, ct, terminator
		expect(parts).toHaveLength(6);
		expect(parts[0]).toEqual(MAGIC);
		expect(new DataView(parts[1]!.buffer).getUint32(0, true)).toBe(DEFAULT_CHUNK_SIZE);
		expect(parts[3]!.length).toBe(12); // iv
		expect(new DataView(parts[2]!.buffer).getUint32(0, true)).toBe(parts[4]!.length);
		expect(new DataView(parts[5]!.buffer).getUint32(0, true)).toBe(0);
	});

	it("splits input into fixed-size chunks via chunkBytes", async () => {
		const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
		const chunks = await collect(chunkBytes(data, 3));
		expect(chunks.map((c) => Array.from(c))).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
		const single = await collect(chunkBytes(data));
		expect(single).toHaveLength(1);
	});

	it("fails with a wrong key", async () => {
		const a = await generateDek();
		const b = await generateDek();
		const blob = await encryptToBlob(a, encoder.encode("audio"));
		await expect(decryptBlob(b, blob)).rejects.toThrow();
	});

	it("rejects non-KTB1 input", async () => {
		const key = await generateDek();
		await expect(decryptBlob(key, new Uint8Array(4))).rejects.toThrow(CryptoFormatError);
		await expect(
			decryptBlob(key, concat([new Uint8Array([0, 0, 0, 0]), u32(1024), u32(0)])),
		).rejects.toThrow(CryptoFormatError);
	});

	it("detects a truncated tail (missing terminator)", async () => {
		const key = await generateDek();
		const blob = await encryptToBlob(key, encoder.encode("audio"), 8);
		// Drop the u32 terminator.
		await expect(decryptBlob(key, blob.subarray(0, blob.length - 4))).rejects.toThrow(
			"missing terminator",
		);
	});

	it("detects a truncated chunk body", async () => {
		const key = await generateDek();
		// chunkSize large enough to admit the declared ctLen, but the
		// iv+ct bytes are not there.
		const blob = concat([MAGIC, u32(DEFAULT_CHUNK_SIZE), u32(64), new Uint8Array(8)]);
		await expect(decryptBlob(key, blob)).rejects.toThrow("truncated chunk");
	});

	it("rejects a chunk larger than the declared chunk size", async () => {
		const key = await generateDek();
		const blob = concat([MAGIC, u32(4), u32(64), new Uint8Array(80), u32(0)]);
		await expect(decryptBlob(key, blob)).rejects.toThrow("chunk exceeds declared chunk size");
	});

	it("fails authentication on a tampered middle chunk", async () => {
		const key = await generateDek();
		const data = crypto.getRandomValues(new Uint8Array(64));
		const blob = await encryptToBlob(key, data, 16); // 4 chunks
		// First chunk layout: [8..12) ctLen, [12..24) iv, [24..24+ctLen) ct.
		const ctLen = new DataView(blob.buffer, blob.byteOffset).getUint32(8, true);
		const tampered = new Uint8Array(blob);
		tampered[24] = tampered[24]! ^ 0xff;
		tampered[24 + ctLen - 1] = tampered[24 + ctLen - 1]! ^ 0xff;
		await expect(decryptBlob(key, tampered)).rejects.toThrow();
	});
});
