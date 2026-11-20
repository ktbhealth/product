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

	it("reads SVG width/height attributes", () => {
		const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>');
		expect(sniffImageSize(svg)).toEqual({ width: 24, height: 24 });
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
