/**
 * Upload-time image dimension sniffing (P-111): reads width/height out of
 * the stored bytes for the formats the upload gate accepts (PNG, JPEG,
 * GIF, WebP, SVG). Returns null when the payload is truncated, unknown
 * or carries no parseable dimensions — callers store NULL and the
 * renderer simply omits the attributes. Pure byte inspection, no
 * dependencies, safe on untrusted input (every read is bounds-checked).
 */

export interface ImageDimensions {
	readonly width: number;
	readonly height: number;
}

const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32be = (b: Uint8Array, o: number): number =>
	((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/** PNG: 8-byte signature, then IHDR length/type — width/height are the
 * first two big-endian u32 of the IHDR data (offset 16). */
const pngSize = (b: Uint8Array): ImageDimensions | null => {
	if (b.length < 24) return null;
	if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
	if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
	const width = u32be(b, 16);
	const height = u32be(b, 20);
	return width > 0 && height > 0 ? { width, height } : null;
};

/** GIF: "GIF8" signature, logical screen width/height as u16le at 6/8. */
const gifSize = (b: Uint8Array): ImageDimensions | null => {
	if (b.length < 10) return null;
	if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x38) return null;
	const width = u16le(b, 6);
	const height = u16le(b, 8);
	return width > 0 && height > 0 ? { width, height } : null;
};

/** JPEG: walk the marker segments until a start-of-frame marker
 * (0xC0–0xCF except C4/C8/CC) whose payload starts with the height/width
 * u16be pair. */
const jpegSize = (b: Uint8Array): ImageDimensions | null => {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 9 < b.length) {
		if (b[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		// Skip fill bytes and standalone markers (RSTn, TEM).
		let marker = b[offset + 1]!;
		while (marker === 0xff && offset + 2 < b.length) {
			offset += 1;
			marker = b[offset + 1]!;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			offset += 2;
			continue;
		}
		const length = u16be(b, offset + 2);
		if (length < 2 || offset + 2 + length > b.length) return null;
		const isSof =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			const height = u16be(b, offset + 5);
			const width = u16be(b, offset + 7);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		offset += 2 + length;
	}
	return null;
};

/** WebP: RIFF container — "WEBP" at 8, then VP8X/VP8 /VP8L chunks carry
 * the canvas size in different bit layouts. */
const webpSize = (b: Uint8Array): ImageDimensions | null => {
	if (b.length < 30) return null;
	const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
	if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
	const chunk = tag(12);
	if (chunk === "VP8X") {
		// 24-bit little-endian width-1 / height-1 at offsets 24/27.
		const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
		const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
		return { width, height };
	}
	if (chunk === "VP8 " && b.length >= 30) {
		// Lossy bitstream: frame tag at 20, start code 9d 012a at 23,
		// then 14-bit width/height little-endian at 26/28.
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
		const width = u16le(b, 26) & 0x3fff;
		const height = u16le(b, 28) & 0x3fff;
		return width > 0 && height > 0 ? { width, height } : null;
	}
	if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
		// Lossless: signature byte 0x2f then 14-bit width-1/height-1 packed
		// little-endian across bytes 21–24.
		const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >> 14) & 0x3fff) + 1;
		return { width, height };
	}
	return null;
};

const SVG_SIZE_RE = /<svg[^>]*>/i;
const SVG_ATTR_RE = /([\w:-]+)\s*=\s*["']([^"']+)["']/g;
const SVG_LENGTH_RE = /^([\d.]+)(px|pt|pc|mm|cm|in|em|rem|%)?$/i;

/** SVG: read width/height attributes (px assumed for unitless values),
 * falling back to the viewBox aspect when only one dimension is given.
 * Percentages and exotic units are ignored — the renderer treats a null
 * size as "unknown". */
const svgSize = (b: Uint8Array): ImageDimensions | null => {
	const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 8192)));
	const tag = SVG_SIZE_RE.exec(head)?.[0];
	if (tag === undefined) return null;
	const attrs = new Map<string, string>();
	for (const match of tag.matchAll(SVG_ATTR_RE)) {
		attrs.set(match[1]!.toLowerCase(), match[2]!);
	}
	const parse = (raw: string | undefined): number | null => {
		if (raw === undefined) return null;
		const m = SVG_LENGTH_RE.exec(raw.trim());
		if (m === null || m[2] !== undefined) return null;
		const value = Number(m[1]);
		return Number.isFinite(value) && value > 0 ? value : null;
	};
	let width = parse(attrs.get("width"));
	let height = parse(attrs.get("height"));
	if ((width === null || height === null) && attrs.get("viewbox") !== undefined) {
		const viewBox = attrs
			.get("viewbox")!
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		if (viewBox.length === 4 && viewBox.every((n) => Number.isFinite(n))) {
			const [, , vbWidth, vbHeight] = viewBox as [number, number, number, number];
			if (width !== null && vbWidth > 0) height = (width * vbHeight) / vbWidth;
			else if (height !== null && vbHeight > 0) width = (height * vbWidth) / vbHeight;
			else if (vbWidth > 0 && vbHeight > 0) {
				width = vbWidth;
				height = vbHeight;
			}
		}
	}
	if (width === null || height === null) return null;
	return { width: Math.round(width), height: Math.round(height) };
};

/** Detect intrinsic dimensions from image bytes. Returns null for
 * truncated, unrecognized or dimension-less payloads. */
export const sniffImageSize = (bytes: Uint8Array): ImageDimensions | null => {
	if (bytes.length === 0) return null;
	// SVG is text — sniff the leading bytes for "<svg"/"<?xml" before the
	// binary probes (binary formats never start with '<').
	if (bytes[0] === 0x3c) return svgSize(bytes);
	return pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
};
