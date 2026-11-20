/**
 * Catalog font subsetting — produces a REAL subset font file (not
 * just a unicode-range download hint) for uploaded catalog fonts.
 *
 * Pipeline: `parseFontVariations` yields the font's merged cmap
 * coverage ranges; this module intersects them with a fixed set of
 * charset groups aligned with Google Fonts' css2 subset names
 * (latin, latin-ext, cyrillic, cyrillic-ext, greek, greek-ext,
 * vietnamese), asks the vendored HarfBuzz WASM (hb-subset.ts) for one
 * font per charset containing only that charset's glyphs, and returns
 * the plan the route stores as sibling R2 objects. Charsets are
 * processed in order and each claims only the coverage no earlier
 * charset took, so the emitted @font-face unicode-ranges stay
 * disjoint. `insertCatalogFontAsset` then emits one face per charset
 * plus a FULL face carrying the complement of ALL subset coverage —
 * browsers download the small per-script files for covered text and
 * the original only for the scripts no subset can render.
 *
 * Scope (v1, deliberate):
 * - CJK is intentionally NOT a subset charset: the ideograph ranges
 *   are enormous, hb-subset on CJK fonts is expensive, and a CJK
 *   subset would rarely be meaningfully smaller than the full font.
 *   CJK codepoints stay in the complement and are served by the full
 *   font face.
 * - Charset ranges overlap slightly (e.g. U+0304 sits in latin,
 *   latin-ext AND vietnamese). First-charset-wins assignment keeps
 *   files and faces disjoint; a later charset's file simply does not
 *   carry the shadowed codepoints — the earlier face serves them.
 * - sfnt uploads (ttf/otf) subset directly; WOFF uploads are
 *   unpacked to sfnt first (per-table zlib via DecompressionStream —
 *   the same mechanism font-metrics.ts uses). WOFF2 uploads are
 *   reconstructed to sfnt by woff2-sfnt.ts (Brotli decode plus the
 *   glyf/loca/hmtx transform inversions); any reconstruction failure
 *   degrades to "keep the full font" exactly like a WOFF unpack
 *   failure.
 * - Variable fonts (fvar present) subset too: the vendored HarfBuzz
 *   build retains fvar/gvar/HVAR/avar/STAT by default (no axis
 *   pinning), and the emitted @font-face keeps its font-level
 *   weightRange/axes descriptors. The subset is only trusted when it
 *   provably kept the variation tables the input carried (fvar, plus
 *   gvar for TrueType-outline fonts and CFF2 for CFF2-outline ones) —
 *   anything less would serve a static font under a variable
 *   descriptor, so it degrades to "keep the full font".
 * - The subset is only emitted when it is strictly smaller than the
 *   uploaded bytes and both unicode-range descriptors fit the emit
 *   cap; every failure degrades to "keep the full font".
 */

import { subsetFontBytes } from "./hb-subset.ts";
import { findTable } from "./font-metrics.ts";
import { woff2ToSfnt } from "./woff2-sfnt.ts";
import { rangesToUnicodeRange, type FontVariationInfo } from "./font-variations.ts";

/** Same serialized-length cap font-variations.ts applies to the
 * full-coverage descriptor — beyond it the hint costs more than it
 * saves, and an over-long per-face range is equally useless. */
const MAX_UNICODE_RANGE_BYTES = 2048;

type Range = readonly [number, number];

/**
 * The "latin" charset — Google's latin unicode-range set, the de-facto
 * baseline every latin-script UI needs. Sorted, non-overlapping.
 */
export const LATIN_SUBSET_RANGES: readonly Range[] = [
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

/**
 * Charset groups for catalog font subsetting, aligned with Google
 * Fonts' css2 subset names where they exist. Order matters: earlier
 * charsets claim shared codepoints first (latin before latin-ext so
 * U+0304-style combining marks ride the latin file). Ranges are the
 * union of each script's typical repertoire — deliberately NOT full
 * Unicode blocks, matching what Google serves per subset. CJK is
 * excluded on purpose (see module doc): the ideograph space is huge
 * and a CJK subset rarely beats the full font.
 */
export const FONT_SUBSET_CHARSETS: readonly {
	readonly name: string;
	readonly ranges: readonly Range[];
}[] = [
	{ name: "latin", ranges: LATIN_SUBSET_RANGES },
	{
		name: "latin-ext",
		ranges: [
			[0x0100, 0x02ba],
			[0x02bd, 0x02c5],
			[0x02c7, 0x02cc],
			[0x02ce, 0x02d7],
			[0x02dd, 0x02ff],
			[0x0304, 0x0304],
			[0x0308, 0x0308],
			[0x0329, 0x0329],
			[0x1d00, 0x1dbf],
			[0x1e00, 0x1e9f],
			[0x1ef2, 0x1eff],
			[0x2020, 0x2020],
			[0x20a0, 0x20ab],
			[0x20ad, 0x20c0],
			[0x2113, 0x2113],
			[0x2c60, 0x2c7f],
			[0xa720, 0xa7ff],
		],
	},
	{
		name: "cyrillic",
		ranges: [
			[0x0301, 0x0301],
			[0x0400, 0x045f],
			[0x0490, 0x0491],
			[0x04b0, 0x04b1],
			[0x2116, 0x2116],
		],
	},
	{
		name: "cyrillic-ext",
		ranges: [
			[0x0460, 0x052f],
			[0x1c80, 0x1c8a],
			[0x20b4, 0x20b4],
			[0x2de0, 0x2dff],
			[0xa640, 0xa69f],
			[0xfe2e, 0xfe2f],
		],
	},
	{
		name: "greek",
		ranges: [
			[0x0370, 0x0377],
			[0x037a, 0x037f],
			[0x0384, 0x038a],
			[0x038c, 0x038c],
			[0x038e, 0x03a1],
			[0x03a3, 0x03ff],
		],
	},
	{ name: "greek-ext", ranges: [[0x1f00, 0x1fff]] },
	{
		name: "vietnamese",
		ranges: [
			[0x0102, 0x0103],
			[0x0110, 0x0111],
			[0x0128, 0x0129],
			[0x0168, 0x0169],
			[0x01a0, 0x01a1],
			[0x01af, 0x01b0],
			[0x0300, 0x0301],
			[0x0303, 0x0304],
			[0x0308, 0x0309],
			[0x0323, 0x0323],
			[0x0329, 0x0329],
			[0x1ea0, 0x1ef9],
			[0x20ab, 0x20ab],
		],
	},
];

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

/** Union of two sorted, non-overlapping range lists. */
const unionRanges = (a: readonly Range[], b: readonly Range[]): Range[] => {
	const out: Range[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		const next = j >= b.length || (i < a.length && a[i]![0] <= b[j]![0]) ? a[i++]! : b[j++]!;
		const last = out[out.length - 1];
		if (last !== undefined && next[0] <= last[1] + 1) {
			// Adjacent/overlapping — extend (inputs are disjoint, so
			// `next` can never be contained, but Math.max keeps the
			// merge total regardless).
			out[out.length - 1] = [last[0], Math.max(last[1], next[1])];
		} else {
			out.push([next[0], next[1]]);
		}
	}
	return out;
};

/** Expand ranges to the flat codepoint list the subsetter consumes.
 * Inputs are charset intersections — bounded by the charset table,
 * so expansion stays cheap. */
const rangesToCodepoints = (ranges: readonly Range[]): number[] => {
	const out: number[] = [];
	for (const [start, stop] of ranges) {
		for (let cp = start; cp <= stop; cp++) out.push(cp);
	}
	return out;
};

/** Serialize ranges, or undefined when the result exceeds the emit
 * cap (mirrors font-variations' pathological-descriptor guard). */
const serializeCapped = (ranges: readonly Range[]): string | undefined => {
	/* v8 ignore next -- callers only pass non-empty range lists */
	if (ranges.length === 0) return undefined;
	const css = rangesToUnicodeRange(ranges);
	return css.length <= MAX_UNICODE_RANGE_BYTES ? css : undefined;
};

/** Hard cap on stored subset objects per upload — the charset table
 * has 7 entries; the bound keeps future additions honest. */
const MAX_SUBSET_FILES = 8;

/** Total bytes across all subset siblings — beyond this the storage
 * cost stops paying for itself (uploads are capped at 10MB). */
const MAX_TOTAL_SUBSET_BYTES = 4 * 1024 * 1024;

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

/** Cap on the reconstructed sfnt — a hostile WOFF can claim
 * origLength values that would allocate gigabytes (zlib-bomb style).
 * Real catalog fonts stay far below this; over-cap degrades to
 * "keep the full font". */
const MAX_WOFF_SFNT_BYTES = 64 * 1024 * 1024;

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
		if (cursor > MAX_WOFF_SFNT_BYTES) return null;
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

/** One stored subset sibling: file bytes plus the charset name the
 * route uses for the `<stem>-<charset>.<ext>` R2 key and the
 * disjoint unicode-range for its @font-face. */
interface CatalogFontSubsetFile {
	readonly charset: string;
	/** Subset font bytes (bare sfnt — ttf or otf flavor). */
	readonly data: Uint8Array;
	/** File extension for the R2 key ("ttf" | "otf"). */
	readonly ext: "ttf" | "otf";
	/** `format()` descriptor hint ("truetype" | "opentype"). */
	readonly format: "truetype" | "opentype";
	/** unicode-range for this subset's @font-face — disjoint from
	 * every other subset's and from
	 * {@link CatalogFontSubsetPlan.fullUnicodeRange}. */
	readonly unicodeRange: string;
}

/** What the route stores: one subset file per covered charset plus
 * the unicode-range descriptor for the FULL-font face (the
 * complement of ALL subset coverage). */
export interface CatalogFontSubsetPlan {
	readonly subsets: readonly CatalogFontSubsetFile[];
	/** unicode-range for the FULL face (coverage − all subset
	 * coverage); absent when the subsets already cover everything the
	 * font can render. */
	readonly fullUnicodeRange?: string;
}

const FORMATS = { ttf: "truetype", otf: "opentype" } as const;

/**
 * Compute the subset plan for an uploaded catalog font, or null when
 * subsetting does not apply or every charset fails — callers keep
 * the full font. `variation` is the parseFontVariations result for
 * the same bytes.
 */
export const subsetCatalogFont = async (input: {
	readonly bytes: Uint8Array;
	readonly variation: FontVariationInfo | null;
	/** Test seam — defaults to the real HarfBuzz WASM subsetter. */
	readonly subsetFont?: (fontData: Uint8Array, unicodes: readonly number[]) => Uint8Array | null;
}): Promise<CatalogFontSubsetPlan | null> => {
	const { bytes, variation } = input;
	if (variation === null) return null;
	const coverage = variation.coverageRanges;
	if (coverage === undefined || coverage.length === 0) return null;
	let sfnt: Uint8Array;
	let flavor: { readonly ext: "ttf" | "otf" } | null;
	const magic = head4(bytes);
	if (magic === "wOFF") {
		const unpacked = await woffToSfnt(bytes);
		if (unpacked === null) return null;
		sfnt = unpacked;
		flavor = sfntFlavor(sfnt);
	} else if (magic === "wOF2") {
		// WOFF2 needs the full transform inversion (glyf/loca/hmtx) —
		// woff2-sfnt.ts handles it; null means "keep the full font".
		const unpacked = await woff2ToSfnt(bytes);
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

	const runSubset = input.subsetFont ?? subsetFontBytes;
	// Coverage already claimed by an accepted charset — keeps every
	// emitted file/face disjoint (first charset wins on overlaps).
	let claimed: Range[] = [];
	const subsets: CatalogFontSubsetFile[] = [];
	let totalSubsetBytes = 0;
	for (const charset of FONT_SUBSET_CHARSETS) {
		/* v8 ignore next -- the charset table has 7 entries; the cap
		 * only guards future growth beyond MAX_SUBSET_FILES. */
		if (subsets.length >= MAX_SUBSET_FILES) break;
		const covered = intersectRanges(coverage, charset.ranges);
		if (covered.length === 0) continue;
		// Only the unclaimed slice earns a file — a charset fully
		// shadowed by earlier ones would be unreachable anyway.
		const assigned = subtractRanges(covered, claimed);
		if (assigned.length === 0) continue;
		const css = serializeCapped(assigned);
		if (css === undefined) continue;
		// The subsetter resolves/instantiates the wasm lazily — a
		// module shape it rejects throws before its own guards run.
		// Same degrade contract as every other failure here: skip this
		// charset, keep whatever the others produced.
		let subset: Uint8Array | null;
		try {
			subset = runSubset(sfnt, rangesToCodepoints(assigned));
		} catch {
			continue;
		}
		if (subset === null) continue;
		// Only worth a second R2 object when the subset actually
		// shrinks the payload relative to what was uploaded.
		if (subset.byteLength >= bytes.byteLength) continue;
		// Budget caps: bounded file count and total stored bytes —
		// later charsets are dropped once either is exhausted.
		if (totalSubsetBytes + subset.byteLength > MAX_TOTAL_SUBSET_BYTES) continue;
		const subsetFlavor = sfntFlavor(subset);
		if (subsetFlavor === null) continue;
		// Variable fonts: only trust the subset when it provably
		// retained the variation machinery — fvar (variation.variable
		// implies the input carried one), plus gvar for
		// TrueType-outline fonts and CFF2 for CFF2-outline ones (CFF2
		// holds its deltas inside the table itself, so there is no
		// separate gvar to check). HarfBuzz keeps all of these by
		// default; the check guards builds/inputs where subsetting
		// would silently emit a static font.
		if (variation.variable) {
			if (findTable(subset, "fvar") === null) continue;
			let lostVariation = false;
			for (const tag of ["gvar", "CFF2"] as const) {
				if (findTable(sfnt, tag) !== null && findTable(subset, tag) === null) {
					lostVariation = true;
					break;
				}
			}
			if (lostVariation) continue;
		}
		subsets.push({
			charset: charset.name,
			data: subset,
			ext: subsetFlavor.ext,
			format: FORMATS[subsetFlavor.ext],
			unicodeRange: css,
		});
		totalSubsetBytes += subset.byteLength;
		claimed = unionRanges(claimed, assigned);
	}
	if (subsets.length === 0) return null;

	const complement = subtractRanges(coverage, claimed);
	const complementCss = complement.length === 0 ? undefined : serializeCapped(complement);
	// A non-empty complement that cannot be serialized means we cannot
	// express disjoint coverage — skip rather than mislead the browser.
	if (complement.length > 0 && complementCss === undefined) return null;
	return {
		subsets,
		...(complementCss === undefined ? {} : { fullUnicodeRange: complementCss }),
	};
};
