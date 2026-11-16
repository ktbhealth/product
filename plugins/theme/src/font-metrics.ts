/**
 * Font metric extraction + metric-matched fallback computation
 * (P-082/PL-006 phase 4).
 *
 * `parseFontMetrics` reads the sfnt tables every browser font needs
 * (head.unitsPerEm, hhea ascent/descent/lineGap, OS/2.xAvgCharWidth)
 * directly from TTF/OTF bytes, from inside a WOFF wrapper (per-table
 * zlib via DecompressionStream), and returns null for anything else —
 * WOFF2 needs brotli, which workerd's DecompressionStream does not
 * provide (TODO: wasm brotli decoder or a metrics sidecar).
 *
 * `computeMetricOverrides` implements the fontaine/capsize algorithm:
 * the fallback face is scaled (size-adjust) so its average glyph width
 * matches the webfont, and its ascent/descent/line-gap are overridden
 * to the webfont's normalized metrics — eliminating layout shift
 * during `font-display: swap`.
 */

import type { ThemeFontFallbackMetrics, ThemeFontSlot } from "./types.ts";

/** Normalized metrics needed for override math (raw font units). */
export interface FontMetrics {
	readonly unitsPerEm: number;
	readonly ascent: number;
	readonly descent: number;
	readonly lineGap: number;
	/** OS/2 xAvgCharWidth; absent → size-adjust falls back to 1. */
	readonly xAvgCharWidth?: number;
}

const u16 = (v: DataView, o: number) => v.getUint16(o);
const i16 = (v: DataView, o: number) => v.getInt16(o);
const u32 = (v: DataView, o: number) => v.getUint32(o);

const text = (v: DataView, o: number, n: number) =>
	String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(o + i)));

interface TableRecord {
	readonly tag: string;
	readonly offset: number;
	readonly length: number;
}

/** Locate `tag` inside an sfnt table directory; null when absent. */
const findTable = (bytes: Uint8Array, tag: string): TableRecord | null => {
	/* v8 ignore next -- callers only reach here with >= 12-byte inputs */
	if (bytes.byteLength < 12) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const numTables = u16(v, 4);
	for (let i = 0; i < numTables; i++) {
		const o = 12 + i * 16;
		if (o + 16 > bytes.byteLength) return null;
		if (text(v, o, 4) === tag) {
			return { tag, offset: u32(v, o + 8), length: u32(v, o + 12) };
		}
	}
	return null;
};

/** Parse head/hhea/OS/2 fields out of a table directory's bytes. */
const metricsFromDirectory = (bytes: Uint8Array): FontMetrics | null => {
	const head = findTable(bytes, "head");
	const hhea = findTable(bytes, "hhea");
	const os2 = findTable(bytes, "OS/2");
	if (head === null || hhea === null) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const inBounds = (t: TableRecord, need: number) => t.offset + need <= bytes.byteLength;
	if (!inBounds(head, 20) || !inBounds(hhea, 10)) return null;
	const unitsPerEm = u16(v, head.offset + 18);
	if (unitsPerEm === 0) return null;
	const ascent = i16(v, hhea.offset + 4);
	const descent = i16(v, hhea.offset + 6);
	const lineGap = i16(v, hhea.offset + 8);
	let xAvgCharWidth: number | undefined;
	if (os2 !== null && inBounds(os2, 4)) {
		xAvgCharWidth = i16(v, os2.offset + 2);
	}
	return { unitsPerEm, ascent, descent, lineGap, xAvgCharWidth };
};

/** WOFF header is 44 bytes; each table record is 20 bytes. */
const WOFF_HEADER_BYTES = 44;
const WOFF_RECORD_BYTES = 20;
const WOFF_SIGNATURE = 0x774f4646; // "wOFF"

const woffTable = async (bytes: Uint8Array, tag: string): Promise<Uint8Array | null> => {
	if (bytes.byteLength < WOFF_HEADER_BYTES) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// woffMetrics only calls this after the wOFF magic check — the
	// signature can never mismatch here.
	/* v8 ignore next -- signature already verified by the caller */
	if (u32(v, 0) !== WOFF_SIGNATURE) return null;
	const numTables = u16(v, 12);
	for (let i = 0; i < numTables; i++) {
		const o = WOFF_HEADER_BYTES + i * WOFF_RECORD_BYTES;
		if (o + WOFF_RECORD_BYTES > bytes.byteLength) return null;
		if (text(v, o, 4) !== tag) continue;
		const offset = u32(v, o + 4);
		const compLength = u32(v, o + 8);
		const origLength = u32(v, o + 12);
		if (offset + compLength > bytes.byteLength) return null;
		const raw = bytes.subarray(offset, offset + compLength);
		if (compLength === origLength) return raw.slice();
		// zlib-compressed table — DecompressionStream("deflate") is the
		// zlib wrapper format WOFF uses.
		if (typeof DecompressionStream === "undefined") return null;
		try {
			const stream = new Blob([raw.slice().buffer as ArrayBuffer])
				.stream()
				.pipeThrough(new DecompressionStream("deflate"));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		} catch {
			return null;
		}
	}
	return null;
};

const WOFF2_TAG = "wOF2";

/**
 * Parse font metrics from raw font bytes. Accepts TTF/OTF sfnt
 * containers and WOFF (zlib tables). Returns null for WOFF2 (brotli —
 * no workerd decoder; TODO) and for unrecognized/corrupt input.
 */
export const parseFontMetrics = async (
	bytes: Uint8Array,
	format?: string,
): Promise<FontMetrics | null> => {
	if (bytes.byteLength < 12) return null;
	const head4 = text(
		new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 4)),
		0,
		4,
	);
	try {
		if (head4 === WOFF2_TAG) return null; // brotli — TODO wasm decoder
		if (head4 === "wOFF") {
			// WOFF stores each sfnt table separately (possibly zlibbed);
			// pull just the three metric tables and parse them via a
			// synthetic two-table view is overkill — parse fields inline.
			return await woffMetrics(bytes);
		}
		// TTF ("true"/"typ1") or CFF OpenType ("OTTO") — plain directory.
		if (head4 === "true" || head4 === "typ1" || head4 === "OTTO") {
			return metricsFromDirectory(bytes);
		}
		// Unknown container: try the directory anyway only when `format`
		// claims a bare sfnt — otherwise reject.
		if (format === "ttf" || format === "otf") return metricsFromDirectory(bytes);
		return null;
	} catch {
		return null;
	}
};

/** Read head/hhea/OS/2 fields out of a WOFF container. */
const woffMetrics = async (bytes: Uint8Array): Promise<FontMetrics | null> => {
	const [head, hhea, os2] = await Promise.all([
		woffTable(bytes, "head"),
		woffTable(bytes, "hhea"),
		woffTable(bytes, "OS/2"),
	]);
	if (head === null || head.byteLength < 20 || hhea === null || hhea.byteLength < 10) {
		return null;
	}
	const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const unitsPerEm = u16(hv, 18);
	if (unitsPerEm === 0) return null;
	const vv = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength);
	let xAvgCharWidth: number | undefined;
	if (os2 !== null && os2.byteLength >= 4) {
		const ov = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
		xAvgCharWidth = i16(ov, 2);
	}
	return {
		unitsPerEm,
		ascent: i16(vv, 4),
		descent: i16(vv, 6),
		lineGap: i16(vv, 8),
		xAvgCharWidth,
	};
};

/** Fallback fonts with published metrics (capsize metrics collection,
 * latin subset xWidthAvg). Keyed by the `local()` family name. */
export const FALLBACK_FONT_METRICS: Readonly<Record<string, FontMetrics>> = {
	arial: {
		unitsPerEm: 2048,
		ascent: 1854,
		descent: -434,
		lineGap: 67,
		xAvgCharWidth: 913,
	},
	"segoe ui": {
		unitsPerEm: 2048,
		ascent: 2210,
		descent: -514,
		lineGap: 0,
		xAvgCharWidth: 908,
	},
	"courier new": {
		unitsPerEm: 2048,
		ascent: 1705,
		descent: -615,
		lineGap: 0,
		xAvgCharWidth: 1229,
	},
	"times new roman": {
		unitsPerEm: 2048,
		ascent: 1825,
		descent: -443,
		lineGap: 87,
		xAvgCharWidth: 832,
	},
	georgia: {
		unitsPerEm: 2048,
		ascent: 1878,
		descent: -449,
		lineGap: 0,
		xAvgCharWidth: 913,
	},
	helvetica: {
		unitsPerEm: 2048,
		ascent: 1577,
		descent: -471,
		lineGap: 0,
		xAvgCharWidth: 913,
	},
	"roboto mono": {
		unitsPerEm: 2048,
		ascent: 2146,
		descent: -555,
		lineGap: 0,
		xAvgCharWidth: 1229,
	},
	"noto sans": {
		unitsPerEm: 1,
		ascent: 1069,
		descent: -293,
		lineGap: 0,
		xAvgCharWidth: 474,
	},
};

/** System font a slot's metric-matched fallback resolves via local(). */
export const localFontForSlot = (slot: ThemeFontSlot): string =>
	slot === "mono" ? "Courier New" : "Arial";

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * fontaine/capsize metric overrides, returned as PERCENTAGES (e.g.
 * 92.4679 means 92.4679%) ready to serialize into the fallback
 * `@font-face`. `fallback` is the system font the local() src names.
 */
export const computeMetricOverrides = (
	font: FontMetrics,
	fallback: FontMetrics,
): ThemeFontFallbackMetrics => {
	const preferredRatio =
		font.xAvgCharWidth !== undefined ? font.xAvgCharWidth / font.unitsPerEm : undefined;
	const fallbackRatio =
		fallback.xAvgCharWidth !== undefined ? fallback.xAvgCharWidth / fallback.unitsPerEm : undefined;
	const sizeAdjust =
		preferredRatio !== undefined && fallbackRatio !== undefined && fallbackRatio !== 0
			? preferredRatio / fallbackRatio
			: 1;
	const adjustedEmSquare = font.unitsPerEm * sizeAdjust;
	return {
		sizeAdjust: round4(sizeAdjust * 100),
		ascentOverride: round4((font.ascent / adjustedEmSquare) * 100),
		descentOverride: round4((Math.abs(font.descent) / adjustedEmSquare) * 100),
		lineGapOverride: round4((font.lineGap / adjustedEmSquare) * 100),
	};
};
