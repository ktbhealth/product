/**
 * Catalog font subsetting — produces a REAL subset font file (not
 * just a unicode-range download hint) for uploaded catalog fonts.
 *
 * Pipeline: `parseFontVariations` yields the font's merged cmap
 * coverage ranges; this module intersects them with the fixed
 * "latin" charset (the same codepoint set Google Fonts calls `latin`),
 * asks the vendored HarfBuzz WASM (hb-subset.ts) for a font containing
 * only those glyphs, and returns the plan the route stores as a
 * sibling R2 object. `insertCatalogFontAsset` then emits TWO disjoint
 * @font-face sets per weight — the subset face carries the latin
 * unicode-range, the full face carries the complement — so browsers
 * download the small file for latin text and the original only for
 * the scripts the subset cannot render.
 *
 * Scope (v1, deliberate):
 * - Bare sfnt uploads (ttf/otf) subset directly; WOFF uploads are
 *   unpacked to sfnt first (per-table zlib via DecompressionStream —
 *   the same mechanism font-metrics.ts uses). WOFF2 is skipped: its
 *   glyf/loca transforms mean the decoded payload is not a valid sfnt,
 *   and the HarfBuzz build has no Brotli decoder for the container.
 * - Variable fonts (fvar present) are skipped entirely — gvar
 *   subsetting plus axis retention is a correctness risk the
 *   unicode-range hint already covers adequately.
 * - The subset is only emitted when it is strictly smaller than the
 *   uploaded bytes and both unicode-range descriptors fit the emit
 *   cap; every failure degrades to "keep the full font".
 */

import { subsetFontBytes } from "./hb-subset.ts";
import { findTable } from "./font-metrics.ts";
import { rangesToUnicodeRange, type FontVariationInfo } from "./font-variations.ts";

/** Same serialized-length cap font-variations.ts applies to the
 * full-coverage descriptor — beyond it the hint costs more than it
 * saves, and an over-long per-face range is equally useless. */
const MAX_UNICODE_RANGE_BYTES = 2048;

/**
 * The "latin" charset — Google's latin unicode-range set, the de-facto
 * baseline every latin-script UI needs. Sorted, non-overlapping.
 */
export const LATIN_SUBSET_RANGES: readonly (readonly [number, number])[] = [
	[0x0000, 0x00ff],
	[0x0131, 0x0131],
	[0x0152, 0x0153],
	[0x02bb, 0x02bc],
	[0x02c6, 0x02c6],
	[0x02da, 0x02da],
	[0x02dc, 0x02dc],
	[0x0304, 0x0304],
	[0x0308, 0x0308],
	[0x0329, 0x0329],
	[0x2000, 0x206f],
	[0x2074, 0x2074],
	[0x20ac, 0x20ac],
	[0x2122, 0x2122],
	[0x2191, 0x2191],
	[0x2193, 0x2193],
	[0x2212, 0x2212],
	[0x2215, 0x2215],
	[0xfeff, 0xfeff],
	[0xfffd, 0xfffd],
];

let latinCodepoints: readonly number[] | null = null;

/** Expand {@link LATIN_SUBSET_RANGES} to the flat codepoint list the
 * subsetter consumes (computed once — ~370 entries). */
export const latinSubsetCodepoints = (): readonly number[] => {
	if (latinCodepoints === null) {
		const out: number[] = [];
		for (const [start, stop] of LATIN_SUBSET_RANGES) {
			for (let cp = start; cp <= stop; cp++) out.push(cp);
		}
		latinCodepoints = out;
	}
	return latinCodepoints;
};

type Range = readonly [number, number];

/** Intersect two sorted, non-overlapping range lists. */
const intersectRanges = (a: readonly Range[], b: readonly Range[]): Range[] => {
	const out: Range[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const start = Math.max(a[i]![0], b[j]![0]);
		const stop = Math.min(a[i]![1], b[j]![1]);
		if (start <= stop) out.push([start, stop]);
		if (a[i]![1] < b[j]![1]) i++;
		else j++;
	}
	return out;
};

/** `a` minus `b` — both sorted, non-overlapping; result likewise. */
const subtractRanges = (a: readonly Range[], b: readonly Range[]): Range[] => {
	const out: Range[] = [];
	let j = 0;
	for (const [start, stop] of a) {
		let cursor = start;
		while (j < b.length && b[j]![1] < cursor) j++;
		for (let k = j; k < b.length && b[k]![0] <= stop; k++) {
			if (b[k]![0] > cursor) out.push([cursor, Math.min(b[k]![0] - 1, stop)]);
			cursor = Math.max(cursor, b[k]![1] + 1);
			if (cursor > stop) break;
		}
		if (cursor <= stop) out.push([cursor, stop]);
	}
	return out;
};

/** Serialize ranges, or undefined when the result exceeds the emit
 * cap (mirrors font-variations' pathological-descriptor guard). */
const serializeCapped = (ranges: readonly Range[]): string | undefined => {
	if (ranges.length === 0) return undefined;
	const css = rangesToUnicodeRange(ranges);
	return css.length <= MAX_UNICODE_RANGE_BYTES ? css : undefined;
};

// ---------- container handling ----------

const u16 = (v: DataView, o: number) => v.getUint16(o);
const u32 = (v: DataView, o: number) => v.getUint32(o);

const head4 = (bytes: Uint8Array): string =>
	String.fromCharCode(...Array.from({ length: 4 }, (_, i) => bytes[i]!));

/** sfnt signature → file extension/format descriptor, or null for
 * containers subsetting cannot consume (WOFF2, collections, garbage). */
const sfntFlavor = (bytes: Uint8Array): { readonly ext: "ttf" | "otf" } | null => {
	const sig = head4(bytes);
	if (sig === "OTTO") return { ext: "otf" };
	// 0x00010000, "true" and "typ1" are all TrueType sfnts.
	if (
		sig === "true" ||
		sig === "typ1" ||
		(bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00)
	) {
		return { ext: "ttf" };
	}
	return null;
};

/** WOFF header is 44 bytes; each table record is 20 bytes. */
const WOFF_HEADER_BYTES = 44;
const WOFF_RECORD_BYTES = 20;

const inflate = async (raw: Uint8Array): Promise<Uint8Array | null> => {
	if (typeof DecompressionStream === "undefined") return null;
	try {
		const stream = new Blob([raw.slice().buffer as ArrayBuffer])
			.stream()
			.pipeThrough(new DecompressionStream("deflate"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	} catch {
		return null;
	}
};

/**
 * Unpack a WOFF container into a bare sfnt (TTF/OTF) byte stream the
 * subsetter can read. Table checksums are copied from the WOFF
 * directory's origChecksum field — they describe the uncompressed
 * table data, which is exactly what sfnt records carry. Returns null
 * on any structural corruption or inflate failure.
 */
const woffToSfnt = async (bytes: Uint8Array): Promise<Uint8Array | null> => {
	// Callers only reach here after the "wOFF" magic check — the
	// signature is guaranteed.
	/* v8 ignore next -- signature already verified by the caller */
	if (bytes.byteLength < WOFF_HEADER_BYTES) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const flavor = u32(v, 4);
	const numTables = u16(v, 12);
	if (numTables === 0 || WOFF_HEADER_BYTES + numTables * WOFF_RECORD_BYTES > bytes.byteLength) {
		return null;
	}
	interface WoffRec {
		readonly tag: string;
		readonly offset: number;
		readonly compLength: number;
		readonly origLength: number;
		readonly checksum: number;
	}
	const recs: WoffRec[] = [];
	for (let i = 0; i < numTables; i++) {
		const o = WOFF_HEADER_BYTES + i * WOFF_RECORD_BYTES;
		recs.push({
			tag: head4(bytes.subarray(o, o + 4)),
			offset: u32(v, o + 4),
			compLength: u32(v, o + 8),
			origLength: u32(v, o + 12),
			checksum: u32(v, o + 16),
		});
	}
	// sfnt directory fields: searchRange/entrySelector/rangeShift follow
	// the TrueType recommendation (max power of two ≤ numTables).
	const maxPow2 = 2 ** Math.floor(Math.log2(numTables));
	const searchRange = maxPow2 * 16;
	const entrySelector = Math.log2(maxPow2);
	const rangeShift = numTables * 16 - searchRange;
	const dirBytes = 12 + numTables * 16;
	// Lay out table data 4-byte aligned after the directory.
	const offsets: number[] = [];
	let cursor = dirBytes;
	for (const r of recs) {
		cursor = (cursor + 3) & ~3;
		offsets.push(cursor);
		cursor += r.origLength;
	}
	const out = new Uint8Array(cursor);
	const ov = new DataView(out.buffer);
	ov.setUint32(0, flavor);
	ov.setUint16(4, numTables);
	ov.setUint16(6, searchRange);
	ov.setUint16(8, entrySelector);
	ov.setUint16(10, rangeShift);
	for (let i = 0; i < recs.length; i++) {
		const r = recs[i]!;
		if (r.offset + r.compLength > bytes.byteLength) return null;
		const raw = bytes.subarray(r.offset, r.offset + r.compLength);
		let table: Uint8Array;
		if (r.compLength === r.origLength) {
			table = raw.slice();
		} else {
			const inflated = await inflate(raw);
			if (inflated === null || inflated.byteLength !== r.origLength) return null;
			table = inflated;
		}
		const ro = 12 + i * 16;
		for (let c = 0; c < 4; c++) ov.setUint8(ro + c, r.tag.charCodeAt(c));
		ov.setUint32(ro + 4, r.checksum);
		ov.setUint32(ro + 8, offsets[i]!);
		ov.setUint32(ro + 12, r.origLength);
		out.set(table, offsets[i]!);
	}
	return out;
};

// ---------- orchestration ----------

/** What the route stores: the subset file plus the two disjoint
 * unicode-range descriptors for the @font-face pair. */
export interface CatalogFontSubsetPlan {
	/** Subset font bytes (bare sfnt — ttf or otf flavor). */
	readonly data: Uint8Array;
	/** File extension for the R2 key ("ttf" | "otf"). */
	readonly ext: "ttf" | "otf";
	/** `format()` descriptor hint ("truetype" | "opentype"). */
	readonly format: "truetype" | "opentype";
	/** unicode-range for the SUBSET face (coverage ∩ latin). */
	readonly unicodeRange: string;
	/** unicode-range for the FULL face (coverage − latin); absent when
	 * the subset already covers everything the font can render. */
	readonly fullUnicodeRange?: string;
}

const FORMATS = { ttf: "truetype", otf: "opentype" } as const;

/**
 * Compute the subset plan for an uploaded catalog font, or null when
 * subsetting does not apply or fails — callers keep the full font.
 * `variation` is the parseFontVariations result for the same bytes.
 */
export const subsetCatalogFont = async (input: {
	readonly bytes: Uint8Array;
	readonly variation: FontVariationInfo | null;
	/** Test seam — defaults to the real HarfBuzz WASM subsetter. */
	readonly subsetFont?: (fontData: Uint8Array, unicodes: readonly number[]) => Uint8Array | null;
}): Promise<CatalogFontSubsetPlan | null> => {
	const { bytes, variation } = input;
	// Variable fonts keep the unicode-range-only path: gvar subsetting
	// plus axis retention is out of scope for v1.
	if (variation === null || variation.variable) return null;
	const coverage = variation.coverageRanges;
	if (coverage === undefined || coverage.length === 0) return null;
	// WOFF2 cannot be unpacked to a valid sfnt (transformed glyf/loca)
	// and the subsetter has no Brotli decoder — skip by magic bytes.
	if (head4(bytes) === "wOF2") return null;

	let sfnt: Uint8Array;
	let flavor: { readonly ext: "ttf" | "otf" } | null;
	if (head4(bytes) === "wOFF") {
		const unpacked = await woffToSfnt(bytes);
		if (unpacked === null) return null;
		sfnt = unpacked;
		flavor = sfntFlavor(sfnt);
	} else {
		flavor = sfntFlavor(bytes);
		sfnt = bytes;
	}
	if (flavor === null) return null;
	// Belt-and-braces: the directory must actually parse.
	if (findTable(sfnt, "head") === null || findTable(sfnt, "cmap") === null) return null;

	const latin = intersectRanges(coverage, LATIN_SUBSET_RANGES);
	const latinCss = serializeCapped(latin);
	if (latinCss === undefined) return null;
	const complement = subtractRanges(coverage, LATIN_SUBSET_RANGES);
	const complementCss = complement.length === 0 ? undefined : serializeCapped(complement);
	// A non-empty complement that cannot be serialized means we cannot
	// express disjoint coverage — skip rather than mislead the browser.
	if (complement.length > 0 && complementCss === undefined) return null;

	const runSubset = input.subsetFont ?? subsetFontBytes;
	const subset = runSubset(sfnt, latinSubsetCodepoints());
	if (subset === null) return null;
	// Only worth a second R2 object when the subset actually shrinks
	// the payload relative to what was uploaded.
	if (subset.byteLength >= bytes.byteLength) return null;
	const subsetFlavor = sfntFlavor(subset);
	if (subsetFlavor === null) return null;
	return {
		data: subset,
		ext: subsetFlavor.ext,
		format: FORMATS[subsetFlavor.ext],
		unicodeRange: latinCss,
		...(complementCss === undefined ? {} : { fullUnicodeRange: complementCss }),
	};
};
