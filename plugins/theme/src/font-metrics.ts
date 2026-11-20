/**
 * Font metric extraction + metric-matched fallback computation
 * (P-082/PL-006 phase 4).
 *
 * `parseFontMetrics` reads the sfnt tables every browser font needs
 * (head.unitsPerEm, hhea ascent/descent/lineGap, OS/2.xAvgCharWidth)
 * directly from TTF/OTF bytes, from inside a WOFF wrapper (per-table
 * zlib via DecompressionStream), and from inside a WOFF2 wrapper
 * (single Brotli stream decoded by a purpose-built zero-import WASM
 * module — workerd has no Brotli in DecompressionStream, rejects
 * runtime WASM compilation, and the deploy runs without
 * nodejs_compat, so a bundled `.wasm` decoder is the portable path).
 * It returns null for anything else — unrecognized or corrupt input.
 *
 * `computeMetricOverrides` implements the fontaine/capsize algorithm:
 * the fallback face is scaled (size-adjust) so its average glyph width
 * matches the webfont, and its ascent/descent/line-gap are overridden
 * to the webfont's normalized metrics — eliminating layout shift
 * during `font-display: swap`.
 */

import { brotliInflate } from "./brotli-dec.ts";
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

export interface TableRecord {
	readonly tag: string;
	readonly offset: number;
	readonly length: number;
}

/** Locate `tag` inside an sfnt table directory; null when absent.
 * Exported for the variation/cmap parser (font-variations.ts) which
 * reads non-metric tables (fvar, cmap) out of the same containers. */
export const findTable = (bytes: Uint8Array, tag: string): TableRecord | null => {
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

/** Read one table out of a WOFF container (raw or zlib-inflated via
 * DecompressionStream). Exported for font-variations.ts. */
export const woffTable = async (bytes: Uint8Array, tag: string): Promise<Uint8Array | null> => {
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
 * WOFF2 "Known Tags" table (WOFF2 spec, TableDirectoryEntry): the low
 * six bits of each directory entry's flags byte index into this list;
 * index 0x3F means a literal 4-byte tag follows instead. Exported for
 * the WOFF2→sfnt reconstructor (woff2-sfnt.ts).
 */
export const WOFF2_KNOWN_TAGS = [
	"cmap",
	"head",
	"hhea",
	"hmtx",
	"maxp",
	"name",
	"OS/2",
	"post",
	"cvt ",
	"fpgm",
	"glyf",
	"loca",
	"prep",
	"CFF ",
	"VORG",
	"EBDT",
	"EBLC",
	"gasp",
	"hdmx",
	"kern",
	"LTSH",
	"PCLT",
	"VDMX",
	"vhea",
	"vmtx",
	"BASE",
	"GDEF",
	"GPOS",
	"GSUB",
	"EBSC",
	"JSTF",
	"MATH",
	"CBDT",
	"CBLC",
	"COLR",
	"CPAL",
	"SVG ",
	"sbix",
	"acnt",
	"avar",
	"bdat",
	"bloc",
	"bsln",
	"cvar",
	"fdsc",
	"feat",
	"fmtx",
	"fvar",
	"gvar",
	"hsty",
	"just",
	"lcar",
	"mort",
	"morx",
	"opbd",
	"prop",
	"trak",
	"Zapf",
	"Silf",
	"Glat",
	"Gloc",
	"Feat",
	"Sill",
] as const;

/** WOFF2 fixed header is 48 bytes; the table directory follows it. */
const WOFF2_HEADER_BYTES = 48;
const WOFF2_CUSTOM_TAG = 0x3f;

/**
 * UIntBase128 (WOFF2 variable-length int): up to five bytes carrying
 * seven bits each, most-significant group first, high bit = continue.
 * Returns [value, nextOffset] or null on truncation/overflow.
 * Exported for the WOFF2→sfnt reconstructor (woff2-sfnt.ts).
 */
export const readBase128 = (
	v: DataView,
	pos: number,
	end: number,
): readonly [number, number] | null => {
	if (pos >= end || v.getUint8(pos) === 0x80) return null; // leading zeros banned
	let result = 0;
	for (let i = 0; i < 5; i++) {
		if (pos >= end) return null;
		const code = v.getUint8(pos++);
		// result must stay < 2^25 before shifting or the u32 overflows.
		if (result >= 0x2000000) return null;
		result = result * 128 + (code & 0x7f);
		if ((code & 0x80) === 0) return [result, pos];
	}
	return null;
};

/** Decompressed WOFF2 payload plus the byte range of every
 * non-transformed table inside it. Transformed tables are skipped —
 * their stored bytes are not the raw sfnt table. */
export interface Woff2TableData {
	readonly data: Uint8Array;
	readonly tables: ReadonlyMap<string, { readonly offset: number; readonly length: number }>;
}

/**
 * Decode a WOFF2 container into its concatenated sfnt table bytes and
 * per-table offsets (cumulative sums in directory order). Returns null
 * on any structural corruption, bad Brotli stream or size mismatch.
 * Shared by the metric parser and the variation/cmap parser.
 */
export const woff2Tables = async (bytes: Uint8Array): Promise<Woff2TableData | null> => {
	if (bytes.byteLength < WOFF2_HEADER_BYTES) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const numTables = u16(v, 12);
	const compressedSize = u32(v, 20);
	const wanted = new Map<string, { offset: number; length: number }>();
	let pos = WOFF2_HEADER_BYTES;
	let dataLength = 0;
	for (let i = 0; i < numTables; i++) {
		if (pos >= bytes.byteLength) return null;
		const flags = v.getUint8(pos++);
		const tagIndex = flags & 0x3f;
		let tag: string;
		if (tagIndex === WOFF2_CUSTOM_TAG) {
			if (pos + 4 > bytes.byteLength) return null;
			tag = text(v, pos, 4);
			pos += 4;
		} else {
			tag = WOFF2_KNOWN_TAGS[tagIndex]!;
		}
		const transformVersion = flags >> 6;
		// glyf/loca use transform version 3 as the null transform; every
		// other table uses version 0 (per the WOFF2 spec / fonttools).
		const transformed =
			tag === "glyf" || tag === "loca" ? transformVersion !== 3 : transformVersion !== 0;
		const orig = readBase128(v, pos, bytes.byteLength);
		if (orig === null) return null;
		pos = orig[1];
		let length = orig[0];
		if (transformed) {
			const transformLength = readBase128(v, pos, bytes.byteLength);
			if (transformLength === null) return null;
			pos = transformLength[1];
			length = transformLength[0];
		}
		if (!transformed) wanted.set(tag, { offset: dataLength, length });
		dataLength += length;
	}
	if (pos + compressedSize > bytes.byteLength) return null;
	const compressed = bytes.subarray(pos, pos + compressedSize);
	let decompressed: Uint8Array;
	try {
		decompressed = brotliInflate(compressed, dataLength);
	} catch {
		return null;
	}
	// The decompressed block is exactly the concatenated (possibly
	// transformed) table data — a size mismatch means a corrupt font.
	if (decompressed.byteLength !== dataLength) return null;
	// Offsets are cumulative sums of non-negative lengths, so every
	// recorded table lies inside the verified decompressed block.
	return { data: decompressed, tables: wanted };
};

/**
 * Read head/hhea/OS/2 fields out of a WOFF2 container via
 * {@link woff2Tables}. Only glyf/loca/hmtx have defined transforms —
 * the metric tables are always stored verbatim, and a transformed
 * metric table is treated as absent.
 */
const woff2Metrics = async (bytes: Uint8Array): Promise<FontMetrics | null> => {
	const decoded = await woff2Tables(bytes);
	if (decoded === null) return null;
	const { data: decompressed, tables: wanted } = decoded;
	// Offsets are cumulative sums of non-negative lengths, so every
	// recorded table lies inside the verified decompressed block.
	const slice = (tag: string): Uint8Array | null => {
		const t = wanted.get(tag);
		return t === undefined ? null : decompressed.subarray(t.offset, t.offset + t.length);
	};
	const head = slice("head");
	const hhea = slice("hhea");
	if (head === null || head.byteLength < 20 || hhea === null || hhea.byteLength < 10) {
		return null;
	}
	const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const unitsPerEm = u16(hv, 18);
	if (unitsPerEm === 0) return null;
	const vv = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength);
	let xAvgCharWidth: number | undefined;
	const os2 = slice("OS/2");
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

/**
 * Parse font metrics from raw font bytes. Accepts TTF/OTF sfnt
 * containers, WOFF (zlib tables) and WOFF2 (Brotli stream via WASM).
 * Returns null for unrecognized/corrupt input.
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
		if (head4 === WOFF2_TAG) return await woff2Metrics(bytes);
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
