/**
 * WOFF2 → bare sfnt (TTF/OTF) reconstruction for the catalog-font
 * subsetting pipeline.
 *
 * `woff2ToSfnt` inverts the WOFF2 container transform: the 48-byte
 * header plus per-table directory entries (known-tag index or literal
 * tag, transform version, UIntBase128 lengths) locate a single Brotli
 * stream — decoded by the bundled `brotli-dec.wasm` module — that
 * holds every table's payload concatenated in directory order.
 *
 * Three table transforms are defined by the spec (and implemented by
 * fontTools' woff2.py, which this module mirrors):
 *
 * - `glyf`/`loca` (transform versions 0-2; version 3 is the null
 *   transform): the glyf payload is split into seven substreams
 *   (contour counts, point counts, per-point flags, coordinate
 *   triplets, composite records, bounding boxes, instructions) that
 *   this module decodes back into per-glyph outline data and
 *   re-encodes as a standard `glyf` table plus matching `loca`
 *   offsets. `loca` itself carries no payload when transformed.
 * - `hmtx` (any non-zero transform version): stores advance widths
 *   plus whichever sidebearing arrays could be omitted; the omitted
 *   bearings are recovered from each glyph's xMin, so reconstruction
 *   runs after glyf is available (decoded or raw).
 * - Every other table MUST use transform version 0 (verbatim bytes);
 *   anything else is an unknown transform and the font is rejected.
 *
 * The output is a normal sfnt: directory sorted by tag, per-table
 * checksums computed over the reconstructed bytes, `head`'s
 * checkSumAdjustment zeroed for its checksum and finally set to
 * 0xB1B0AFBA minus the whole-font checksum, and
 * `head.indexToLocFormat` rewritten to the emitted loca format when
 * the caller rebuilt glyf/loca. All failures return null so callers
 * keep the original upload.
 */

import { brotliInflate } from "./brotli-dec.ts";
import { readBase128, WOFF2_KNOWN_TAGS } from "./font-metrics.ts";

const u16 = (v: DataView, o: number) => v.getUint16(o);
const i16 = (v: DataView, o: number) => v.getInt16(o);
const i8 = (v: DataView, o: number) => v.getInt8(o);
const u32 = (v: DataView, o: number) => v.getUint32(o);

const text = (v: DataView, o: number, n: number) =>
	String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(o + i)));

/** Same ceiling font-subset.ts applies to WOFF unpacking — a hostile
 * container must not trigger a giant allocation. */
const MAX_SFNT_BYTES = 64 * 1024 * 1024;

/** WOFF2 fixed header is 48 bytes; the table directory follows it. */
const WOFF2_HEADER_BYTES = 48;
const WOFF2_CUSTOM_TAG = 0x3f;
/** Directory entry flags: low 6 bits = known-tag index, high 2 = transform version. */
const KNOWN_TAG_MASK = 0x3f;

interface Woff2Entry {
	readonly tag: string;
	readonly transformed: boolean;
	readonly origLength: number;
	/** Bytes this table occupies inside the decompressed stream —
	 * `transformLength` when transformed (0 for `loca`), else
	 * `origLength`. */
	readonly streamLength: number;
	/** Offset into the decompressed stream, assigned after Brotli decode. */
	offset: number;
}

interface Woff2Directory {
	readonly flavor: number;
	readonly entries: readonly Woff2Entry[];
	/** Total decompressed stream size (sum of streamLengths). */
	readonly dataLength: number;
	readonly compressedOffset: number;
	readonly compressedSize: number;
}

/**
 * Parse the WOFF2 table directory. Returns null on truncation, a
 * transform we do not implement, duplicate tags, or a decompressed
 * size beyond the safety cap.
 */
const parseWoff2Directory = (bytes: Uint8Array): Woff2Directory | null => {
	if (bytes.byteLength < WOFF2_HEADER_BYTES) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const numTables = u16(v, 12);
	if (numTables === 0) return null;
	const compressedSize = u32(v, 20);
	const flavor = u32(v, 4);
	const entries: Woff2Entry[] = [];
	const seen = new Set<string>();
	let pos = WOFF2_HEADER_BYTES;
	let dataLength = 0;
	for (let i = 0; i < numTables; i++) {
		if (pos >= bytes.byteLength) return null;
		const flags = v.getUint8(pos++);
		const tagIndex = flags & KNOWN_TAG_MASK;
		let tag: string;
		if (tagIndex === WOFF2_CUSTOM_TAG) {
			if (pos + 4 > bytes.byteLength) return null;
			tag = text(v, pos, 4);
			pos += 4;
		} else {
			tag = WOFF2_KNOWN_TAGS[tagIndex]!;
		}
		if (seen.has(tag)) return null;
		seen.add(tag);
		const transformVersion = flags >> 6;
		// glyf/loca use transform version 3 as the null transform;
		// every other table uses version 0 (WOFF2 spec / fontTools).
		const isGlyfLoca = tag === "glyf" || tag === "loca";
		const transformed = isGlyfLoca ? transformVersion !== 3 : transformVersion !== 0;
		// Only glyf/loca/hmtx have defined transforms.
		if (transformed && tag !== "glyf" && tag !== "loca" && tag !== "hmtx") return null;
		const orig = readBase128(v, pos, bytes.byteLength);
		if (orig === null) return null;
		pos = orig[1];
		let streamLength = orig[0];
		if (transformed) {
			const transformLength = readBase128(v, pos, bytes.byteLength);
			if (transformLength === null) return null;
			pos = transformLength[1];
			streamLength = transformLength[0];
			// The transformed 'loca' entry must carry no payload — its
			// offsets are rebuilt from the reconstructed glyf table.
			if (tag === "loca" && streamLength !== 0) return null;
		}
		dataLength += streamLength;
		if (dataLength > MAX_SFNT_BYTES) return null;
		entries.push({ tag, transformed, origLength: orig[0], streamLength, offset: 0 });
	}
	if (pos + compressedSize > bytes.byteLength) return null;
	return { flavor, entries, dataLength, compressedOffset: pos, compressedSize };
};

// ---------- sfnt checksums ----------

/** Sum of a table's bytes as big-endian u32 words, zero-padded to a
 * 4-byte boundary. Accumulated mod 2^32 per word so the running sum
 * never leaves the exact-integer range. */
const tableChecksum = (data: Uint8Array): number => {
	let sum = 0;
	for (let i = 0; i < data.length; i += 4) {
		let word = 0;
		for (let j = 0; j < 4; j++) {
			word = word * 256 + (i + j < data.length ? data[i + j]! : 0);
		}
		sum = (sum + word) >>> 0;
	}
	return sum;
};

/**
 * Lay out `tables` (tag → bytes) as a complete sfnt: directory sorted
 * by tag, 4-byte-aligned table data, per-table checksums, and a
 * correct `head.checkSumAdjustment`. `locaFormat` is the format of a
 * caller-rebuilt loca (null for verbatim tables — head is then left
 * untouched apart from the checksum adjustment).
 */
const assembleSfnt = (
	flavor: number,
	tables: ReadonlyMap<string, Uint8Array>,
	locaFormat: 0 | 1 | null,
): Uint8Array | null => {
	const sorted = [...tables.entries()].sort((a, b) => {
		for (let i = 0; i < 4; i++) {
			const d = a[0].charCodeAt(i) - b[0].charCodeAt(i);
			if (d !== 0) return d;
		}
		/* v8 ignore next -- table tags are unique (Map keys), so the
		 * comparator never reaches the equal case */
		return 0;
	});
	const numTables = sorted.length;
	const maxPow2 = 2 ** Math.floor(Math.log2(numTables));
	const dirBytes = 12 + numTables * 16;
	const offsets: number[] = [];
	let cursor = dirBytes;
	for (const [, data] of sorted) {
		cursor = (cursor + 3) & ~3;
		offsets.push(cursor);
		cursor += data.length;
		/* v8 ignore next -- defensive: reaching this needs a decompressed
		 * stream within a few MB of the 64MB cap (reconstructed glyf can
		 * exceed its transform stream), i.e. an unrealistically large
		 * catalog font upload. */
		if (cursor > MAX_SFNT_BYTES) return null;
	}
	const out = new Uint8Array(cursor);
	const ov = new DataView(out.buffer);
	ov.setUint32(0, flavor);
	ov.setUint16(4, numTables);
	ov.setUint16(6, maxPow2 * 16);
	ov.setUint16(8, Math.log2(maxPow2));
	ov.setUint16(10, numTables * 16 - maxPow2 * 16);
	let headDataOffset = -1;
	for (let i = 0; i < sorted.length; i++) {
		const [tag, data0] = sorted[i]!;
		// head ships with checkSumAdjustment zeroed for its own
		// checksum; the real value is patched in after layout. When the
		// caller rebuilt glyf/loca, indexToLocFormat (head+50) is
		// rewritten to the emitted loca format on the same copy.
		let data = data0;
		if (tag === "head" && data.length >= 12) {
			data = data.slice();
			const hv = new DataView(data.buffer, data.byteOffset, data.length);
			hv.setUint32(8, 0);
			if (locaFormat !== null && data.length >= 52) hv.setInt16(50, locaFormat);
			headDataOffset = offsets[i]!;
		}
		const ro = 12 + i * 16;
		for (let c = 0; c < 4; c++) ov.setUint8(ro + c, tag.charCodeAt(c));
		ov.setUint32(ro + 4, tableChecksum(data));
		ov.setUint32(ro + 8, offsets[i]!);
		ov.setUint32(ro + 12, data.length);
		out.set(data, offsets[i]!);
	}
	if (headDataOffset >= 0) {
		// checkSumAdjustment = 0xB1B0AFBA - checksum(entire font).
		const total = tableChecksum(out);
		ov.setUint32(headDataOffset + 8, (0xb1b0afba - total) >>> 0);
	}
	return out;
};

// ---------- 255UInt16 (WOFF2 packed small ints) ----------

/** Decode one 255UInt16 value at `pos` inside `data`; returns
 * [value, nextPos] or null on truncation (mirrors fontTools'
 * unpack255UShort). */
const read255 = (data: Uint8Array, pos: number): readonly [number, number] | null => {
	if (pos >= data.length) return null;
	const code = data[pos]!;
	if (code === 253) {
		if (pos + 3 > data.length) return null;
		return [data[pos + 1]! * 256 + data[pos + 2]!, pos + 3];
	}
	if (code === 254) {
		if (pos + 2 > data.length) return null;
		return [data[pos + 1]! + 506, pos + 2];
	}
	if (code === 255) {
		if (pos + 2 > data.length) return null;
		return [data[pos + 1]! + 253, pos + 2];
	}
	return [code, pos + 1];
};

// ---------- transformed glyf/loca ----------

/** WOFF2 glyf transform header: version/optionFlags/numGlyphs/
 * indexFormat (4×u16) followed by seven u32 substream sizes. */
const GLYF_TRANSFORM_HEADER = 36;
const GLYF_SUBSTREAMS = 7;
/** glyf transform optionFlags bit 0 → overlapSimpleBitmap present. */
const OVERLAP_SIMPLE_BITMAP_FLAG = 0x0001;

/** Composite-component flag bits (TrueType glyf spec). */
const ARG_WORDS = 0x0001;
const ARG_XY = 0x0002;
const ROUND_XY_TO_GRID = 0x0004;
const SCALE = 0x0008;
const NON_OVERLAPPING = 0x0010;
const MORE_COMPONENTS = 0x0020;
const X_AND_Y_SCALE = 0x0040;
const TWO_BY_TWO = 0x0080;
const HAVE_INSTRUCTIONS = 0x0100;
const USE_MY_METRICS = 0x0200;
const OVERLAP_COMPOUND = 0x0400;
const SCALED_COMPONENT_OFFSET = 0x0800;
const UNSCALED_COMPONENT_OFFSET = 0x1000;
/** Flag bits preserved verbatim through decode→encode (fontTools keeps
 * exactly these; the structural bits are recomputed). */
const COMPONENT_KEEP_MASK =
	ROUND_XY_TO_GRID |
	NON_OVERLAPPING |
	USE_MY_METRICS |
	OVERLAP_COMPOUND |
	SCALED_COMPONENT_OFFSET |
	UNSCALED_COMPONENT_OFFSET;

interface DecodedComponent {
	readonly glyphId: number;
	readonly argsAreXY: boolean;
	/** First arg: x offset (xy mode) or first point index (point mode). */
	readonly a1: number;
	/** Second arg: y offset or second point index. */
	readonly a2: number;
	readonly hasTransform: boolean;
	/** Raw F2DOT14 values in file order [a, b, c, d] (identity when
	 * !hasTransform). */
	readonly transform: readonly [number, number, number, number];
	readonly flags: number;
}

type DecodedGlyph =
	| { readonly kind: "empty" }
	| {
			readonly kind: "simple";
			readonly numberOfContours: number;
			readonly endPts: readonly number[];
			readonly xs: readonly number[];
			readonly ys: readonly number[];
			readonly onCurve: Uint8Array;
			readonly overlapSimple: boolean;
			readonly instructions: Uint8Array;
			readonly bbox: readonly [number, number, number, number];
	  }
	| {
			readonly kind: "composite";
			readonly components: readonly DecodedComponent[];
			readonly instructions: Uint8Array | null;
			readonly bbox: readonly [number, number, number, number];
	  };

interface GlyfDecodeResult {
	readonly glyphs: readonly DecodedGlyph[];
	readonly numGlyphs: number;
	readonly indexFormat: number;
	/** Per-glyph xMin (0 for empty glyphs) — feeds hmtx reconstruction. */
	readonly xMins: Int16Array;
}

/** WOFF2 transform flag → signed coordinate delta magnitude. `flag`
 * is the already-masked (<0x80) flag byte; the sign bit is bit 0 for
 * x and bit 1 for y (passed as `flag >> 1`). */
const withSign = (flag: number, base: number) => ((flag & 1) === 1 ? base : -base);

/**
 * Decode a transformed `glyf` payload into per-glyph outline data.
 * Returns null on any structural corruption — every stream read is
 * bounds-checked.
 */
const decodeTransformedGlyf = (data: Uint8Array): GlyfDecodeResult | null => {
	if (data.byteLength < GLYF_TRANSFORM_HEADER) return null;
	const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const optionFlags = u16(v, 2);
	const numGlyphs = u16(v, 4);
	const indexFormat = u16(v, 6);
	// Seven substreams, sizes at offsets 8..35; their bytes follow the
	// header in declaration order.
	const sizes: number[] = [];
	for (let i = 0; i < GLYF_SUBSTREAMS; i++) sizes.push(u32(v, 8 + i * 4));
	const bases: number[] = [];
	let pos = GLYF_TRANSFORM_HEADER;
	for (const size of sizes) {
		bases.push(pos);
		pos += size;
		if (pos > data.byteLength) return null;
	}
	const [ncBase, npBase, flBase, glBase, cpBase, bbBase, insBase] = bases as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const [ncSize, npSize, flSize, glSize, cpSize, bbSize, insSize] = sizes as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];
	// bboxStream starts with a packed bitmap (one bit per glyph, in
	// 4-byte aligned groups); the remaining bytes are 8-byte bbox
	// records present only for glyphs whose bit is set.
	const bboxBitmapBytes = ((numGlyphs + 31) >> 5) << 2;
	if (bbSize < bboxBitmapBytes) return null;
	const bboxDataBase = bbBase + bboxBitmapBytes;
	const bboxDataLen = bbSize - bboxBitmapBytes;
	// Optional overlapSimpleBitmap trails the seven substreams.
	let ovBase = -1;
	if ((optionFlags & OVERLAP_SIMPLE_BITMAP_FLAG) !== 0) {
		const ovSize = (numGlyphs + 7) >> 3;
		if (pos + ovSize > data.byteLength) return null;
		ovBase = pos;
		pos += ovSize;
	}
	// The streams plus optional bitmap must consume the payload exactly.
	if (pos !== data.byteLength) return null;

	const ncEnd = ncBase + ncSize;
	const npEnd = npBase + npSize;
	const glEnd = glBase + glSize;
	const cursors = { np: 0, fl: 0, gl: 0, cp: 0, bb: 0, ins: 0 };

	const readGlyphStream255 = (): number | null => {
		const r = read255(data.subarray(glBase, glEnd), cursors.gl);
		if (r === null) return null;
		cursors.gl = r[1];
		return r[0];
	};
	const readInstructions = (): Uint8Array | null => {
		const len = readGlyphStream255();
		if (len === null || cursors.ins + len > insSize) return null;
		const out = data.slice(insBase + cursors.ins, insBase + cursors.ins + len);
		cursors.ins += len;
		return out;
	};
	/** Read the stored bbox record when the glyph's bitmap bit is set;
	 * `computed` is the coordinate-derived fallback for simple glyphs
	 * (null for composites, which must carry a stored bbox). */
	const readBBox = (
		i: number,
		computed: readonly [number, number, number, number] | null,
	): readonly [number, number, number, number] | null => {
		const have = (data[bbBase + (i >> 3)]! & (0x80 >> (i & 7))) !== 0;
		if (!have) return computed;
		if (cursors.bb + 8 > bboxDataLen) return null;
		const o = bboxDataBase + cursors.bb;
		cursors.bb += 8;
		return [i16(v, o), i16(v, o + 2), i16(v, o + 4), i16(v, o + 6)];
	};

	const glyphs: DecodedGlyph[] = new Array(numGlyphs);
	const xMins = new Int16Array(numGlyphs);
	for (let i = 0; i < numGlyphs; i++) {
		const ncPos = ncBase + i * 2;
		if (ncPos + 2 > ncEnd) return null;
		const nContours = i16(v, ncPos);
		if (nContours === 0) {
			glyphs[i] = { kind: "empty" };
			continue;
		}
		if (nContours === -1) {
			// Composite glyph: component records from compositeStream,
			// optional instructions via a glyphStream length prefix plus
			// instructionStream bytes.
			const components: DecodedComponent[] = [];
			let haveInstructions = false;
			for (;;) {
				if (cursors.cp + 4 > cpSize) return null;
				const fo = cpBase + cursors.cp;
				const flags = u16(v, fo);
				const glyphId = u16(v, fo + 2);
				cursors.cp += 4;
				const argsAreXY = (flags & ARG_XY) !== 0;
				const words = (flags & ARG_WORDS) !== 0;
				let a1: number;
				let a2: number;
				if (words) {
					if (cursors.cp + 4 > cpSize) return null;
					a1 = i16(v, cpBase + cursors.cp);
					a2 = i16(v, cpBase + cursors.cp + 2);
					cursors.cp += 4;
				} else {
					if (cursors.cp + 2 > cpSize) return null;
					a1 = i8(v, cpBase + cursors.cp);
					a2 = i8(v, cpBase + cursors.cp + 1);
					cursors.cp += 2;
				}
				let hasTransform = false;
				let transform: readonly [number, number, number, number] = [0, 0, 0, 0];
				if ((flags & SCALE) !== 0) {
					if (cursors.cp + 2 > cpSize) return null;
					const s = i16(v, cpBase + cursors.cp);
					cursors.cp += 2;
					transform = [s, 0, 0, s];
					hasTransform = true;
				} else if ((flags & X_AND_Y_SCALE) !== 0) {
					if (cursors.cp + 4 > cpSize) return null;
					const x = i16(v, cpBase + cursors.cp);
					const y = i16(v, cpBase + cursors.cp + 2);
					cursors.cp += 4;
					transform = [x, 0, 0, y];
					hasTransform = true;
				} else if ((flags & TWO_BY_TWO) !== 0) {
					if (cursors.cp + 8 > cpSize) return null;
					transform = [
						i16(v, cpBase + cursors.cp),
						i16(v, cpBase + cursors.cp + 2),
						i16(v, cpBase + cursors.cp + 4),
						i16(v, cpBase + cursors.cp + 6),
					];
					cursors.cp += 8;
					hasTransform = true;
				}
				haveInstructions = haveInstructions || (flags & HAVE_INSTRUCTIONS) !== 0;
				components.push({
					glyphId,
					argsAreXY,
					a1,
					a2,
					hasTransform,
					transform,
					flags: flags & COMPONENT_KEEP_MASK,
				});
				if ((flags & MORE_COMPONENTS) === 0) break;
			}
			const instructions = haveInstructions ? readInstructions() : null;
			if (haveInstructions && instructions === null) return null;
			const bbox = readBBox(i, null);
			if (bbox === null) return null;
			xMins[i] = bbox[0];
			glyphs[i] = { kind: "composite", components, instructions, bbox };
			continue;
		}
		if (nContours < -1) return null;
		// Simple glyph: contour end points from nPointsStream, per-point
		// flags from flagStream, coordinate triplets from glyphStream.
		const endPts: number[] = [];
		let endPoint = -1;
		for (let c = 0; c < nContours; c++) {
			const r = read255(data.subarray(npBase, npEnd), cursors.np);
			if (r === null) return null;
			cursors.np = r[1];
			endPoint += r[0];
			if (endPoint < 0 || endPoint > 0xffff) return null;
			endPts.push(endPoint);
		}
		const nPoints = endPts[nContours - 1]! + 1;
		if (cursors.fl + nPoints > flSize) return null;
		const onCurve = new Uint8Array(nPoints);
		const xs = new Array<number>(nPoints);
		const ys = new Array<number>(nPoints);
		let x = 0;
		let y = 0;
		for (let j = 0; j < nPoints; j++) {
			let f = data[flBase + cursors.fl + j]!;
			onCurve[j] = (f & 0x80) === 0 ? 1 : 0;
			f &= 0x7f;
			// Number of coordinate bytes packed for this flag value.
			const nBytes = f < 84 ? 1 : f < 120 ? 2 : f < 124 ? 3 : 4;
			if (cursors.gl + nBytes > glSize) return null;
			const go = glBase + cursors.gl;
			const b = (k: number) => data[go + k]!;
			let dx: number;
			let dy: number;
			if (f < 10) {
				dx = 0;
				dy = withSign(f, ((f & 14) << 7) + b(0));
			} else if (f < 20) {
				dx = withSign(f, (((f - 10) & 14) << 7) + b(0));
				dy = 0;
			} else if (f < 84) {
				const b0 = f - 20;
				const b1 = b(0);
				dx = withSign(f, 1 + (b0 & 0x30) + (b1 >> 4));
				dy = withSign(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
			} else if (f < 120) {
				const b0 = f - 84;
				dx = withSign(f, 1 + (Math.floor(b0 / 12) << 8) + b(0));
				dy = withSign(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + b(1));
			} else if (f < 124) {
				const b2 = b(1);
				dx = withSign(f, (b(0) << 4) + (b2 >> 4));
				dy = withSign(f >> 1, ((b2 & 0x0f) << 8) + b(2));
			} else {
				dx = withSign(f, (b(0) << 8) + b(1));
				dy = withSign(f >> 1, (b(2) << 8) + b(3));
			}
			cursors.gl += nBytes;
			x += dx;
			y += dy;
			xs[j] = x;
			ys[j] = y;
		}
		cursors.fl += nPoints;
		const instructions = readInstructions();
		if (instructions === null) return null;
		// overlapSimple rides on the first point's flag (nPoints >= 1).
		const overlapSimple = ovBase >= 0 && (data[ovBase + (i >> 3)]! & (0x80 >> (i & 7))) !== 0;
		// Bounding box: stored when the bitmap bit is set, otherwise
		// recomputed from the point coordinates. nPoints >= 1 always —
		// endPts values are validated non-negative above.
		let bbox: readonly [number, number, number, number];
		if ((data[bbBase + (i >> 3)]! & (0x80 >> (i & 7))) !== 0) {
			const stored = readBBox(i, null);
			if (stored === null) return null;
			bbox = stored;
		} else {
			let xMin = xs[0]!;
			let yMin = ys[0]!;
			let xMax = xs[0]!;
			let yMax = ys[0]!;
			for (let j = 1; j < nPoints; j++) {
				if (xs[j]! < xMin) xMin = xs[j]!;
				if (ys[j]! < yMin) yMin = ys[j]!;
				if (xs[j]! > xMax) xMax = xs[j]!;
				if (ys[j]! > yMax) yMax = ys[j]!;
			}
			bbox = [xMin, yMin, xMax, yMax];
		}
		// Coordinates must fit the int16 glyf format (a stored bbox is
		// already int16 by construction; a computed one is bounded by
		// the coordinates checked here).
		for (let j = 0; j < nPoints; j++) {
			if (xs[j]! < -32768 || xs[j]! > 32767 || ys[j]! < -32768 || ys[j]! > 32767) {
				return null;
			}
		}
		xMins[i] = bbox[0];
		glyphs[i] = {
			kind: "simple",
			numberOfContours: nContours,
			endPts,
			xs,
			ys,
			onCurve,
			overlapSimple,
			instructions,
			bbox,
		};
	}
	return { glyphs, numGlyphs, indexFormat, xMins };
};

// ---------- standard glyf/loca encoding ----------

const pushI16 = (out: number[], val: number) => {
	out.push((val >> 8) & 0xff, val & 0xff);
};
const pushU16 = (out: number[], val: number) => {
	out.push((val >> 8) & 0xff, val & 0xff);
};

/**
 * Encode one decoded glyph as standard glyf bytes (returned as a
 * byte array; empty glyphs produce zero bytes — equal consecutive
 * loca offsets). No flag RLE: every point flag is emitted literally,
 * which is valid glyf, just slightly larger.
 */
const compileGlyph = (glyph: DecodedGlyph): number[] => {
	const out: number[] = [];
	if (glyph.kind === "empty") return out;
	const [xMin, yMin, xMax, yMax] = glyph.bbox;
	if (glyph.kind === "composite") {
		pushI16(out, -1);
		pushI16(out, xMin);
		pushI16(out, yMin);
		pushI16(out, xMax);
		pushI16(out, yMax);
		const last = glyph.components.length - 1;
		for (let k = 0; k < glyph.components.length; k++) {
			const comp = glyph.components[k]!;
			// Component record order: flags, glyphID, args, transform.
			// Args/transform sizes depend on the final flag bits, so
			// build them in a scratch buffer first.
			const tail: number[] = [];
			let flags = comp.flags;
			if (k !== last) flags |= MORE_COMPONENTS;
			const hasInstructions =
				k === last && glyph.instructions !== null && glyph.instructions.length > 0;
			if (hasInstructions) flags |= HAVE_INSTRUCTIONS;
			if (comp.argsAreXY) {
				flags |= ARG_XY;
				const x = comp.a1;
				const y = comp.a2;
				if (x >= -128 && x <= 127 && y >= -128 && y <= 127) {
					tail.push(x & 0xff, y & 0xff);
				} else {
					flags |= ARG_WORDS;
					pushI16(tail, x);
					pushI16(tail, y);
				}
			} else if (comp.a1 <= 255 && comp.a2 <= 255) {
				// Point indices decode as unsigned — always >= 0.
				tail.push(comp.a1, comp.a2);
			} else {
				flags |= ARG_WORDS;
				pushU16(tail, comp.a1);
				pushU16(tail, comp.a2);
			}
			if (comp.hasTransform) {
				const [a, b, c, d] = comp.transform;
				if (b !== 0 || c !== 0) {
					flags |= TWO_BY_TWO;
					pushI16(tail, a);
					pushI16(tail, b);
					pushI16(tail, c);
					pushI16(tail, d);
				} else if (a !== d) {
					flags |= X_AND_Y_SCALE;
					pushI16(tail, a);
					pushI16(tail, d);
				} else {
					flags |= SCALE;
					pushI16(tail, a);
				}
			}
			pushU16(out, flags);
			pushU16(out, comp.glyphId);
			out.push(...tail);
		}
		if (glyph.instructions !== null && glyph.instructions.length > 0) {
			pushU16(out, glyph.instructions.length);
			for (const byte of glyph.instructions) out.push(byte);
		}
		return out;
	}
	// Simple glyph.
	pushI16(out, glyph.numberOfContours);
	pushI16(out, xMin);
	pushI16(out, yMin);
	pushI16(out, xMax);
	pushI16(out, yMax);
	for (const end of glyph.endPts) pushU16(out, end);
	pushU16(out, glyph.instructions.length);
	for (const byte of glyph.instructions) out.push(byte);
	// flags[], then all x deltas, then all y deltas.
	const flagBytes: number[] = [];
	const xBytes: number[] = [];
	const yBytes: number[] = [];
	const nPoints = glyph.xs.length;
	let prevX = 0;
	let prevY = 0;
	for (let j = 0; j < nPoints; j++) {
		let flag = glyph.onCurve[j] === 1 ? 0x01 : 0;
		if (j === 0 && glyph.overlapSimple) flag |= 0x40;
		const dx = glyph.xs[j]! - prevX;
		const dy = glyph.ys[j]! - prevY;
		prevX = glyph.xs[j]!;
		prevY = glyph.ys[j]!;
		if (dx === 0) {
			flag |= 0x10;
		} else if (dx >= -255 && dx <= 255) {
			flag |= 0x02;
			if (dx > 0) {
				flag |= 0x10;
				xBytes.push(dx);
			} else {
				xBytes.push(-dx);
			}
		} else {
			pushI16(xBytes, dx);
		}
		if (dy === 0) {
			flag |= 0x20;
		} else if (dy >= -255 && dy <= 255) {
			flag |= 0x04;
			if (dy > 0) {
				flag |= 0x20;
				yBytes.push(dy);
			} else {
				yBytes.push(-dy);
			}
		} else {
			pushI16(yBytes, dy);
		}
		flagBytes.push(flag);
	}
	// Spreading ~200k elements into push() can exceed argument limits
	// on pathological glyphs — append in a loop instead.
	for (const b of flagBytes) out.push(b);
	for (const b of xBytes) out.push(b);
	for (const b of yBytes) out.push(b);
	return out;
};

/**
 * Turn the decoded glyphs into `glyf` + `loca` table bytes. Glyph
 * data is padded to 4-byte boundaries (what WOFF2 encoders emit for
 * OTS compatibility); the loca format follows the transform's
 * declared indexFormat when it fits, otherwise long offsets are
 * emitted and the caller patches head.indexToLocFormat.
 */
const compileGlyfLopa = (
	decoded: GlyfDecodeResult,
): { readonly glyf: Uint8Array; readonly loca: Uint8Array; readonly locaFormat: 0 | 1 } | null => {
	const locations: number[] = [0];
	const parts: Uint8Array[] = [];
	let cursor = 0;
	for (const glyph of decoded.glyphs) {
		const bytes = compileGlyph(glyph);
		const padded = bytes.length % 4 === 0 ? bytes.length : bytes.length + (4 - (bytes.length % 4));
		const chunk = new Uint8Array(padded);
		chunk.set(bytes);
		parts.push(chunk);
		cursor += padded;
		locations.push(cursor);
		/* v8 ignore next -- defensive: exceeding 64MB of compiled glyf
		 * requires a ~64MB decompressed transform stream (itself capped
		 * at MAX_SFNT_BYTES), so real fonts never reach this. */
		if (cursor > MAX_SFNT_BYTES) return null;
	}
	let glyf: Uint8Array;
	if (cursor === 0) {
		// All-empty font: emit a single pad byte so the table is
		// non-empty (OTS/Windows quirk, same as fontTools).
		glyf = new Uint8Array([0]);
	} else {
		glyf = new Uint8Array(cursor);
		let o = 0;
		for (const part of parts) {
			glyf.set(part, o);
			o += part.length;
		}
	}
	// Short loca stores offset/2 as u16 — usable only when every
	// offset is even (guaranteed by 4-byte padding) and the last fits.
	const useShort = decoded.indexFormat === 0 && cursor < 0x20000;
	const loca = new Uint8Array((decoded.numGlyphs + 1) * (useShort ? 2 : 4));
	const lv = new DataView(loca.buffer);
	for (let i = 0; i <= decoded.numGlyphs; i++) {
		if (useShort) lv.setUint16(i * 2, locations[i]! / 2);
		else lv.setUint32(i * 4, locations[i]!);
	}
	return { glyf, loca, locaFormat: useShort ? 0 : 1 };
};

// ---------- transformed hmtx ----------

/**
 * Rebuild a standard `hmtx` table from its WOFF2 transform payload.
 * `xMins` supplies the per-glyph left sidebearing for whichever
 * array the transform omitted. Returns null on structural corruption.
 */
const reconstructHmtx = (
	data: Uint8Array,
	numGlyphs: number,
	xMins: Int16Array,
	numberOfHMetrics: number,
): Uint8Array | null => {
	if (data.byteLength < 1) return null;
	const flags = data[0]!;
	// Bits 2-7 are reserved; bit 0 = lsb array absent, bit 1 =
	// leftSideBearing array absent; both absent is invalid.
	if ((flags & 0xfc) !== 0) return null;
	const hasLsbArray = (flags & 0x01) === 0;
	const hasLeftSideBearingArray = (flags & 0x02) === 0;
	if (!hasLsbArray && !hasLeftSideBearingArray) return null;
	// hhea.numberOfHMetrics is clamped to numGlyphs (fontTools does the
	// same); a zero count leaves no advance width to repeat.
	const nHM = Math.min(numberOfHMetrics, numGlyphs);
	if (nHM < 1) return null;
	const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let pos = 1;
	const need = (n: number) => {
		if (pos + n > data.byteLength) return false;
		pos += n;
		return true;
	};
	const advanceWidths = new Uint16Array(nHM);
	for (let i = 0; i < nHM; i++) {
		if (!need(2)) return null;
		advanceWidths[i] = u16(v, pos - 2);
	}
	const lsbs = new Int16Array(nHM);
	if (hasLsbArray) {
		for (let i = 0; i < nHM; i++) {
			if (!need(2)) return null;
			lsbs[i] = i16(v, pos - 2);
		}
	} else {
		for (let i = 0; i < nHM; i++) lsbs[i] = xMins[i]!;
	}
	const sideBearings = numGlyphs - nHM;
	const trailing = new Int16Array(sideBearings);
	if (hasLeftSideBearingArray) {
		for (let i = 0; i < sideBearings; i++) {
			if (!need(2)) return null;
			trailing[i] = i16(v, pos - 2);
		}
	} else {
		for (let i = 0; i < sideBearings; i++) trailing[i] = xMins[nHM + i]!;
	}
	if (pos !== data.byteLength) return null;
	// Standard hmtx: nHM × (u16 advance, i16 lsb), then one i16 left
	// sidebearing per remaining glyph (advances repeat the last
	// advance width).
	const out = new Uint8Array(nHM * 4 + sideBearings * 2);
	const ov = new DataView(out.buffer);
	for (let i = 0; i < nHM; i++) {
		ov.setUint16(i * 4, advanceWidths[i]!);
		ov.setInt16(i * 4 + 2, lsbs[i]!);
	}
	// Trailing glyphs carry only a left sidebearing — their advance
	// width implicitly repeats advanceWidths[nHM-1].
	for (let i = 0; i < sideBearings; i++) {
		ov.setInt16(nHM * 4 + i * 2, trailing[i]!);
	}
	return out;
};

/** Read xMin for every glyph out of a RAW (untransformed) glyf table
 * using the raw loca offsets and head.indexToLocFormat. */
const rawGlyfXmins = (
	glyf: Uint8Array,
	loca: Uint8Array,
	locaFormat: number,
): { readonly numGlyphs: number; readonly xMins: Int16Array } | null => {
	const entrySize = locaFormat === 0 ? 2 : 4;
	if (locaFormat !== 0 && locaFormat !== 1) return null;
	if (loca.byteLength < entrySize * 2 || loca.byteLength % entrySize !== 0) return null;
	const numGlyphs = loca.byteLength / entrySize - 1;
	const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
	const gv = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
	const readLoc = (i: number) => (locaFormat === 0 ? lv.getUint16(i * 2) * 2 : lv.getUint32(i * 4));
	const xMins = new Int16Array(numGlyphs);
	for (let i = 0; i < numGlyphs; i++) {
		const start = readLoc(i);
		const end = readLoc(i + 1);
		if (end < start || end > glyf.byteLength) return null;
		if (end === start) continue; // empty glyph → xMin 0
		// Every non-empty glyph starts with a 10-byte header whose
		// xMin sits at offset +2 — a shorter slice is malformed.
		if (end - start < 10) return null;
		xMins[i] = gv.getInt16(start + 2);
	}
	return { numGlyphs, xMins };
};

// ---------- orchestration ----------

/**
 * Reconstruct a bare sfnt (TTF/OTF) byte stream from a WOFF2
 * container. Returns null on any structural corruption, unsupported
 * transform, decompression failure or size overflow — callers degrade
 * to keeping the uploaded font.
 */
export const woff2ToSfnt = async (bytes: Uint8Array): Promise<Uint8Array | null> => {
	// Callers only reach here after the "wOF2" magic check.
	/* v8 ignore next -- signature already verified by the caller */
	if (
		bytes.byteLength < 4 ||
		text(new DataView(bytes.buffer, bytes.byteOffset, 4), 0, 4) !== "wOF2"
	) {
		return null;
	}
	const dir = parseWoff2Directory(bytes);
	if (dir === null) return null;
	const compressed = bytes.subarray(
		dir.compressedOffset,
		dir.compressedOffset + dir.compressedSize,
	);
	let decompressed: Uint8Array;
	try {
		decompressed = brotliInflate(compressed, dir.dataLength);
	} catch {
		return null;
	}
	if (decompressed.byteLength !== dir.dataLength) return null;
	let cursor = 0;
	for (const entry of dir.entries) {
		entry.offset = cursor;
		cursor += entry.streamLength;
	}
	const slice = (entry: Woff2Entry): Uint8Array =>
		decompressed.subarray(entry.offset, entry.offset + entry.streamLength);
	const byTag = new Map(dir.entries.map((e) => [e.tag, e]));

	const tables = new Map<string, Uint8Array>();
	let locaFormat: 0 | 1 | null = null;

	// --- glyf/loca ---
	const glyfEntry = byTag.get("glyf");
	const locaEntry = byTag.get("loca");
	const glyfTransformed = glyfEntry?.transformed ?? false;
	const locaTransformed = locaEntry?.transformed ?? false;
	// The spec transforms them as a pair; a lone transformed member is
	// malformed.
	if (glyfTransformed !== locaTransformed) return null;
	// Per-glyph xMins + glyph count for hmtx reconstruction.
	let glyfContext: { readonly numGlyphs: number; readonly xMins: Int16Array } | null = null;
	if (glyfTransformed) {
		const decoded = decodeTransformedGlyf(slice(glyfEntry!));
		if (decoded === null) return null;
		const compiled = compileGlyfLopa(decoded);
		/* v8 ignore next -- compileGlyfLopa only fails on the 64MB
		 * defensive cap, unreachable for streams already capped */
		if (compiled === null) return null;
		tables.set("glyf", compiled.glyf);
		tables.set("loca", compiled.loca);
		locaFormat = compiled.locaFormat;
		glyfContext = { numGlyphs: decoded.numGlyphs, xMins: decoded.xMins };
	} else {
		if (glyfEntry !== undefined) tables.set("glyf", slice(glyfEntry));
		if (locaEntry !== undefined) tables.set("loca", slice(locaEntry));
		// Raw glyf xMins are only needed when hmtx is transformed.
		const hmtxEntry = byTag.get("hmtx");
		if (hmtxEntry?.transformed === true) {
			const headEntry = byTag.get("head");
			const glyfRaw = glyfEntry !== undefined ? slice(glyfEntry) : null;
			const locaRaw = locaEntry !== undefined ? slice(locaEntry) : null;
			if (
				glyfRaw === null ||
				locaRaw === null ||
				headEntry === undefined ||
				headEntry.streamLength < 52
			) {
				return null;
			}
			const headBytes = slice(headEntry);
			const hv = new DataView(headBytes.buffer, headBytes.byteOffset, headBytes.byteLength);
			const parsed = rawGlyfXmins(glyfRaw, locaRaw, i16(hv, 50));
			if (parsed === null) return null;
			glyfContext = parsed;
		}
	}

	// --- hmtx ---
	const hmtxEntry = byTag.get("hmtx");
	if (hmtxEntry !== undefined) {
		if (hmtxEntry.transformed) {
			const hheaEntry = byTag.get("hhea");
			if (hheaEntry === undefined || hheaEntry.streamLength < 36) {
				return null;
			}
			// glyfContext is guaranteed non-null here: a transformed
			// hmtx either follows a decoded glyf/loca pair or went
			// through the raw-glyf path above (both set it or already
			// returned null).
			/* v8 ignore next -- unreachable: invariant documented above */
			if (glyfContext === null) return null;
			const hheaBytes = slice(hheaEntry);
			const numberOfHMetrics = u16(
				new DataView(hheaBytes.buffer, hheaBytes.byteOffset, hheaBytes.byteLength),
				34,
			);
			const rebuilt = reconstructHmtx(
				slice(hmtxEntry),
				glyfContext.numGlyphs,
				glyfContext.xMins,
				numberOfHMetrics,
			);
			if (rebuilt === null) return null;
			tables.set("hmtx", rebuilt);
		} else {
			tables.set("hmtx", slice(hmtxEntry));
		}
	}

	// --- every other table is verbatim ---
	for (const entry of dir.entries) {
		if (entry.tag === "glyf" || entry.tag === "loca" || entry.tag === "hmtx") continue;
		tables.set(entry.tag, slice(entry));
	}

	return assembleSfnt(dir.flavor, tables, locaFormat);
};
