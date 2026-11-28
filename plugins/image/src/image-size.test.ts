import { describe, expect, it } from "vitest";

import { sniffImageSize } from "./image-size.ts";

const bytes = (...parts: Array<number[] | Uint8Array | string>): Uint8Array => {
	const out: number[] = [];
	for (const part of parts) {
		if (typeof part === "string") {
			for (const ch of part) out.push(ch.charCodeAt(0));
		} else {
			out.push(...part);
		}
	}
	return new Uint8Array(out);
};

const u32be = (n: number): number[] => [
	(n >>> 24) & 0xff,
	(n >>> 16) & 0xff,
	(n >>> 8) & 0xff,
	n & 0xff,
];
const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];

/** Minimal PNG: signature + IHDR length/type + width/height. */
const png = (width: number, height: number) =>
	bytes(
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		u32be(13),
		[0x49, 0x48, 0x44, 0x52], // "IHDR"
		u32be(width),
		u32be(height),
		[8, 6, 0, 0, 0],
	);

const gif = (width: number, height: number) => bytes("GIF89a", u16le(width), u16le(height), [0, 0]);

/** Minimal JPEG: SOI + APP0 segment + SOF0 with height/width. */
const jpeg = (width: number, height: number) =>
	bytes(
		[0xff, 0xd8],
		[0xff, 0xe0],
		u16be(16),
		new Array(14).fill(0),
		[0xff, 0xc0],
		u16be(17),
		[8],
		u16be(height),
		u16be(width),
		new Array(10).fill(0),
	);

/** WebP VP8X: RIFF/WEBP headers + VP8X chunk with 24-bit w-1/h-1. */
const webpVp8x = (width: number, height: number) => {
	const w = width - 1;
	const h = height - 1;
	return bytes(
		"RIFF",
		[0, 0, 0, 0],
		"WEBP",
		"VP8X",
		[10, 0, 0, 0],
		[0, 0, 0, 0],
		[w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff],
		[h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff],
	);
};

/** JPEG variant: SOI + a run of fill bytes, standalone markers and a
 * non-FF gap before the SOF — exercises the marker-walk edge paths. */
const jpegEdge = () =>
	bytes(
		[0xff, 0xd8],
		[0xff, 0xff, 0xff], // fill bytes before the marker code
		[0xff, 0x01], // TEM — standalone, no length
		[0xff, 0xd0], // RST0 — standalone
		[0x00, 0x11], // garbage between markers (non-FF skip)
		[0xff, 0xe1],
		u16be(4),
		[0xaa, 0xbb],
		[0xff, 0xc2], // SOF2 (progressive) also counts
		u16be(11),
		[8],
		u16be(111),
		u16be(222),
		new Array(4).fill(0),
	);

/** WebP lossy (VP8 ): frame tag + start code + 14-bit dims. */
const webpVp8 = (width: number, height: number) => {
	const w = width & 0x3fff;
	const h = height & 0x3fff;
	return bytes(
		"RIFF",
		[0, 0, 0, 0],
		"WEBP",
		"VP8 ",
		[0, 0, 0, 0],
		new Array(3).fill(0), // frame tag
		[0x9d, 0x01, 0x2a], // start code
		[w & 0xff, (w >> 8) & 0x3f],
		[h & 0xff, (h >> 8) & 0x3f],
	);
};

/** WebP lossless (VP8L): signature 0x2f + packed 14-bit w-1/h-1. */
const webpVp8l = (width: number, height: number) => {
	const bits = (width - 1) | ((height - 1) << 14);
	return bytes(
		"RIFF",
		[0, 0, 0, 0],
		"WEBP",
		"VP8L",
		[0, 0, 0, 0],
		[0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff],
		// webpSize requires ≥30 bytes — pad past the VP8L payload.
		new Array(5).fill(0),
	);
};

describe("sniffImageSize", () => {
	it("reads PNG dimensions from IHDR", () => {
		expect(sniffImageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
	});

	it("reads GIF logical screen dimensions", () => {
		expect(sniffImageSize(gif(320, 200))).toEqual({ width: 320, height: 200 });
	});

	it("walks JPEG markers to the first SOF", () => {
		expect(sniffImageSize(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
	});

	it("reads WebP VP8X canvas size", () => {
		expect(sniffImageSize(webpVp8x(800, 600))).toEqual({ width: 800, height: 600 });
	});

	it("reads WebP VP8 lossy and VP8L lossless sizes", () => {
		expect(sniffImageSize(webpVp8(640, 480))).toEqual({ width: 640, height: 480 });
		expect(sniffImageSize(webpVp8l(320, 200))).toEqual({ width: 320, height: 200 });
	});

	it("rejects WebP with unknown chunks, bad start codes and short buffers", () => {
		// Unknown chunk tag.
		expect(
			sniffImageSize(bytes("RIFF", [0, 0, 0, 0], "WEBP", "JUNK", new Array(20).fill(0))),
		).toBeNull();
		// VP8 chunk but wrong start code.
		const badStart = webpVp8(10, 10);
		badStart[23] = 0x00;
		expect(sniffImageSize(badStart)).toBeNull();
		// VP8L without the 0x2f signature.
		const badVp8l = webpVp8l(10, 10);
		badVp8l[20] = 0x00;
		expect(sniffImageSize(badVp8l)).toBeNull();
		// RIFF/WEBP header but truncated before any chunk.
		expect(sniffImageSize(bytes("RIFF", [0, 0, 0, 0], "WEBP"))).toBeNull();
		expect(sniffImageSize(bytes("RIFF", [0, 0, 0, 0], "JUNK", new Array(30).fill(0)))).toBeNull();
	});

	it("walks JPEG fill bytes, standalone markers and non-FF gaps", () => {
		expect(sniffImageSize(jpegEdge())).toEqual({ width: 222, height: 111 });
	});

	it("rejects truncated JPEGs, bad lengths and non-SOF tails", () => {
		// Declared segment length runs past the buffer.
		expect(
			sniffImageSize(bytes([0xff, 0xd8], [0xff, 0xe0], u16be(60), new Array(10).fill(0))),
		).toBeNull();
		// Length < 2 is invalid.
		expect(
			sniffImageSize(bytes([0xff, 0xd8], [0xff, 0xe0], u16be(1), new Array(10).fill(0))),
		).toBeNull();
		// SOF excluded markers (DHT C4, JPG C8, DAC CC) don't count.
		for (const marker of [0xc4, 0xc8, 0xcc]) {
			expect(
				sniffImageSize(bytes([0xff, 0xd8], [0xff, marker], u16be(9), new Array(7).fill(0))),
			).toBeNull();
		}
		// Marker with zero dimensions → null.
		expect(
			sniffImageSize(
				bytes([0xff, 0xd8], [0xff, 0xc0], u16be(11), [8], u16be(0), u16be(0), new Array(4).fill(0)),
			),
		).toBeNull();
		// SOI only / trailing garbage.
		expect(sniffImageSize(bytes([0xff, 0xd8]))).toBeNull();
		expect(sniffImageSize(bytes("not a jpeg"))).toBeNull();
	});

	it("rejects PNGs with a corrupt IHDR type or zero dimensions", () => {
		const badType = png(10, 10);
		badType[12] = 0x58; // "XHDR" instead of "IHDR"
		expect(sniffImageSize(badType)).toBeNull();
		expect(sniffImageSize(png(0, 10))).toBeNull();
		expect(sniffImageSize(png(10, 0))).toBeNull();
	});

	it("rejects zero-dimension GIF and VP8 payloads", () => {
		expect(sniffImageSize(gif(0, 10))).toBeNull();
		expect(sniffImageSize(webpVp8(0, 10))).toBeNull();
	});

	it("returns null for '<' payloads that are not SVG", () => {
		expect(sniffImageSize(bytes("<html><body>nope</body></html>"))).toBeNull();
	});

	it("derives SVG dimensions from viewBox when attrs are missing", () => {
		const mk = (attrs: string) => bytes(`<svg xmlns="x" ${attrs}></svg>`);
		// Width only → height from the viewBox aspect.
		expect(sniffImageSize(mk('width="100" viewBox="0 0 200 100"'))).toEqual({
			width: 100,
			height: 50,
		});
		// Height only → width from the viewBox aspect.
		expect(sniffImageSize(mk('height="50" viewBox="0 0 200 100"'))).toEqual({
			width: 100,
			height: 50,
		});
		// Neither → raw viewBox extents.
		expect(sniffImageSize(mk('viewBox="0 0 200 100"'))).toEqual({ width: 200, height: 100 });
		// Degenerate viewBox extents can't rescue a missing dimension.
		expect(sniffImageSize(mk('width="100" viewBox="0 0 0 100"'))).toBeNull();
		expect(sniffImageSize(mk('height="50" viewBox="0 0 100 0"'))).toBeNull();
		// Malformed viewBox is ignored entirely.
		expect(sniffImageSize(mk('width="100" viewBox="0 0 100"'))).toBeNull();
		expect(sniffImageSize(mk('width="100" height="50" viewBox="bogus"'))).toEqual({
			width: 100,
			height: 50,
		});
		// Non-positive and non-numeric attribute values parse to null.
		expect(sniffImageSize(mk('width="0" height="50"'))).toBeNull();
		expect(sniffImageSize(mk('width="abc" height="50"'))).toBeNull();
	});

	it("reads SVG width/height attributes", () => {
		const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>');
		expect(sniffImageSize(svg)).toEqual({ width: 24, height: 24 });
	});

	it("accepts explicit px units but rejects other units", () => {
		expect(sniffImageSize(bytes('<svg width="100px" height="50PX"></svg>'))).toEqual({
			width: 100,
			height: 50,
		});
		expect(sniffImageSize(bytes('<svg width="100pt" height="50"></svg>'))).toBeNull();
		expect(sniffImageSize(bytes('<svg width="10em" height="50"></svg>'))).toBeNull();
	});

	it("derives SVG dimensions from viewBox when attributes are absent", () => {
		const svg = bytes('<svg viewBox="0 0 100 50"></svg>');
		expect(sniffImageSize(svg)).toEqual({ width: 100, height: 50 });
	});

	it("returns null for empty, truncated and unknown payloads", () => {
		expect(sniffImageSize(new Uint8Array(0))).toBeNull();
		expect(sniffImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(sniffImageSize(png(10, 10).subarray(0, 20))).toBeNull();
		expect(sniffImageSize(bytes("not an image at all"))).toBeNull();
	});

	it("returns null for SVG without resolvable dimensions", () => {
		expect(sniffImageSize(bytes('<svg width="100%" height="100%"></svg>'))).toBeNull();
		expect(sniffImageSize(bytes("<svg></svg>"))).toBeNull();
		expect(sniffImageSize(bytes('<?xml version="1.0"?><svg viewBox="0 0 10 10"></svg>'))).toEqual({
			width: 10,
			height: 10,
		});
	});
});
