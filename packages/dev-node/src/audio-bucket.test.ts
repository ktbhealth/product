import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeLocalAudioBucket } from "./audio-bucket.ts";

let dir: string | undefined;
const bucketDir = () => {
	dir ??= mkdtempSync(join(tmpdir(), "ktb-audio-"));
	return dir;
};

afterEach(() => {
	if (dir !== undefined) {
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
});

describe("makeLocalAudioBucket", () => {
	it("round-trips bytes with content type metadata", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		const bytes = new TextEncoder().encode("fake-audio-bytes");
		await bucket.put("audio/u1/42/abc.wav", bytes, {
			httpMetadata: { contentType: "audio/wav" },
		});

		const object = await bucket.get("audio/u1/42/abc.wav");
		expect(object).not.toBeNull();
		expect(object!.size).toBe(bytes.byteLength);
		expect(object!.httpMetadata?.contentType).toBe("audio/wav");
		expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
		// body stream carries the same payload (route GET path).
		expect(new Uint8Array(await new Response(object!.body).arrayBuffer())).toEqual(bytes);
	});

	it("returns null for missing keys and deletes objects + meta", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		expect(await bucket.get("nope.bin")).toBeNull();

		await bucket.put("a/b/c.bin", new Uint8Array([1, 2, 3]), {
			httpMetadata: { contentType: "application/octet-stream" },
		});
		const file = join(bucketDir(), "a", "b", "c.bin");
		expect(existsSync(file)).toBe(true);
		expect(existsSync(file + ".ktb-meta.json")).toBe(true);

		await bucket.delete(["a/b/c.bin"]);
		expect(await bucket.get("a/b/c.bin")).toBeNull();
		expect(existsSync(file)).toBe(false);
		expect(existsSync(file + ".ktb-meta.json")).toBe(false);
	});

	it("accepts ArrayBuffer and ReadableStream values; overwrite clears stale meta", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		const ab = new Uint8Array([9, 8, 7]).buffer;
		await bucket.put("x.bin", ab, { httpMetadata: { contentType: "text/plain" } });
		await bucket.put(
			"x.bin",
			new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array([1]));
					c.close();
				},
			}),
		);
		const object = await bucket.get("x.bin");
		expect(object!.httpMetadata?.contentType).toBeUndefined();
		expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([1]));
	});

	it("rejects keys that escape the storage dir or are invalid", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		await expect(bucket.put("../escape.bin", new Uint8Array([1]))).rejects.toThrow(
			/escapes storage dir/,
		);
		await expect(bucket.get("/etc/passwd")).rejects.toThrow(/escapes storage dir/);
		await expect(bucket.put("", new Uint8Array([1]))).rejects.toThrow(/invalid audio key/);
		await expect(bucket.put("a\0b.bin", new Uint8Array([1]))).rejects.toThrow(/invalid audio key/);
		// "." resolves to the bucket root itself — writeFile fails EISDIR.
		await expect(bucket.put(".", new Uint8Array([1]))).rejects.toThrow(/illegal operation|EISDIR/);
	});

	it("surfaces non-ENOENT read errors and accepts a single delete key", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		// "blocked" as a plain file makes "blocked/x.bin" an ENOTDIR read.
		writeFileSync(join(bucketDir(), "blocked"), "not a dir");
		await expect(bucket.get("blocked/x.bin")).rejects.toThrow(/ENOTDIR|not a directory/);

		await bucket.put("solo.bin", new Uint8Array([5]), {
			httpMetadata: { contentType: "application/octet-stream" },
		});
		await bucket.delete("solo.bin");
		expect(await bucket.get("solo.bin")).toBeNull();
	});

	it("ignores malformed sidecar metadata", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		await bucket.put("meta.bin", new Uint8Array([1]), {
			httpMetadata: { contentType: "text/plain" },
		});
		writeFileSync(join(bucketDir(), "meta.bin.ktb-meta.json"), '{"contentType":123}');
		const object = await bucket.get("meta.bin");
		expect(object!.httpMetadata?.contentType).toBeUndefined();
	});

	it("list() inventories object files, skips sidecars and sorts keys", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		expect(await bucket.list()).toEqual({ objects: [], truncated: false });
		await bucket.put("b/two.wav", new Uint8Array([1, 2]), {
			httpMetadata: { contentType: "audio/wav" },
		});
		await bucket.put("a/one.wav", new Uint8Array([1, 2, 3]));
		const result = await bucket.list();
		expect(result.truncated).toBe(false);
		expect(result.objects).toEqual([
			{ key: "a/one.wav", size: 3 },
			{ key: "b/two.wav", size: 2 },
		]);
	});

	it("head() reports size and content type, null when missing", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		expect(await bucket.head("missing.bin")).toBeNull();
		await bucket.put("h.bin", new Uint8Array([1, 2, 3, 4]), {
			httpMetadata: { contentType: "audio/wav" },
		});
		expect(await bucket.head("h.bin")).toEqual({
			size: 4,
			httpMetadata: { contentType: "audio/wav" },
		});
		// Non-ENOENT stat errors propagate (ENOTDIR via a file-as-dir).
		writeFileSync(join(bucketDir(), "blocked"), "not a dir");
		await expect(bucket.head("blocked/x.bin")).rejects.toThrow(/ENOTDIR|not a directory/);
	});

	it("get() honours R2 range semantics (offset+length, suffix, offset-only)", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		await bucket.put("r.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
		const slice = async (range: { offset?: number; length?: number; suffix?: number }) =>
			new Uint8Array(await (await bucket.get("r.bin", { range }))!.arrayBuffer());
		expect(await slice({ offset: 2, length: 3 })).toEqual(new Uint8Array([2, 3, 4]));
		expect(await slice({ suffix: 4 })).toEqual(new Uint8Array([6, 7, 8, 9]));
		expect(await slice({ offset: 7 })).toEqual(new Uint8Array([7, 8, 9]));
		expect(await slice({ length: 2 })).toEqual(new Uint8Array([0, 1]));
	});

	it("list() tolerates a missing store dir as zero objects", async () => {
		const bucket = makeLocalAudioBucket(join(bucketDir(), "does-not-exist"));
		expect(await bucket.list()).toEqual({ objects: [], truncated: false });
	});

	it("list() surfaces non-ENOENT walk errors", async () => {
		// Rooting the bucket at a plain file makes readdir fail ENOTDIR —
		// only ENOENT (missing store dir) is tolerated.
		const root = join(bucketDir(), "not-a-dir");
		writeFileSync(root, "x");
		const bucket = makeLocalAudioBucket(root);
		await expect(bucket.list()).rejects.toThrow(/ENOTDIR|not a directory/);
	});

	it("head() returns size and content type, null for missing keys", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		expect(await bucket.head("nope.bin")).toBeNull();

		await bucket.put("h/take.wav", new Uint8Array([1, 2, 3, 4]), {
			httpMetadata: { contentType: "audio/wav" },
		});
		const head = await bucket.head("h/take.wav");
		expect(head?.size).toBe(4);
		expect(head?.httpMetadata?.contentType).toBe("audio/wav");
	});

	it("head() surfaces non-ENOENT stat errors", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		// A plain file blocks "blocked/x.bin" — stat fails ENOTDIR, not ENOENT.
		writeFileSync(join(bucketDir(), "blocked"), "not a dir");
		await expect(bucket.head("blocked/x.bin")).rejects.toThrow(/ENOTDIR|not a directory/);
	});

	it("get() honours R2 range options: offset, length and suffix", async () => {
		const bucket = makeLocalAudioBucket(bucketDir());
		await bucket.put("r.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
		const bytes = async (range?: { offset?: number; length?: number; suffix?: number }) => {
			const object = await bucket.get("r.bin", { range });
			return new Uint8Array(await object!.arrayBuffer());
		};

		// offset + length slice.
		expect(await bytes({ offset: 2, length: 3 })).toEqual(new Uint8Array([2, 3, 4]));
		// offset alone reads to EOF.
		expect(await bytes({ offset: 5 })).toEqual(new Uint8Array([5, 6, 7]));
		// Empty range object: offset defaults to 0, length to EOF.
		expect(await bytes({})).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
		// suffix takes the last N bytes; oversized suffix clamps to the file.
		expect(await bytes({ suffix: 2 })).toEqual(new Uint8Array([6, 7]));
		expect(await bytes({ suffix: 99 })).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
		// suffix + length: last N bytes then slice.
		expect(await bytes({ suffix: 4, length: 2 })).toEqual(new Uint8Array([4, 5]));
	});
});
