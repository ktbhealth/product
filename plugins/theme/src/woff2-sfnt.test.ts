import { brotliCompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findTable } from "./font-metrics.ts";
import { woff2ToSfnt } from "./woff2-sfnt.ts";

const fixtureWoff2 = (name: string) =>
	new Uint8Array(readFileSync(fileURLToPath(new URL(`./testdata/${name}`, import.meta.url))));

// ---------- byte helpers ----------

const tag = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const u16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
const i16 = (v: number): number[] => u16(v & 0xffff);
const i8 = (v: number): number[] => [v & 0xff];
const u32 = (v: number): number[] => [
	(v >>> 24) & 0xff,
	(v >>> 16) & 0xff,
	(v >>> 8) & 0xff,
	v & 0xff,
];

/** UIntBase128 encoder (inverse of font-metrics' readBase128). */
const base128 = (v: number): number[] => {
	const digits: number[] = [];
	let n = v;
	do {
		digits.unshift(n % 128);
		n = Math.floor(n / 128);
	} while (n > 0);
	return digits.map((d, i) => (i < digits.length - 1 ? d | 0x80 : d));
};

/** 255UInt16 encoder — canonical form only (the decoder accepts the
 * non-canonical 254/255 lead-byte forms too; those are exercised via
 * instruction lengths below). */
const enc255 = (v: number): number[] => {
	if (v < 253) return [v];
	if (v <= 0xffff) return [253, (v >> 8) & 0xff, v & 0xff];
	throw new Error("too large");
};

// ---------- WOFF2 container builder ----------

const WOFF2_KNOWN_TAG_INDEX: Record<string, number> = {
	cmap: 0,
	head: 1,
	hhea: 2,
	hmtx: 3,
	maxp: 4,
	name: 5,
	"OS/2": 6,
	post: 7,
	"cvt ": 8,
	fpgm: 9,
	glyf: 10,
	loca: 11,
	prep: 12,
	"CFF ": 13,
};

interface Woff2TableSpec {
	readonly name: string;
	readonly stored: readonly number[];
	readonly origLength?: number;
	readonly transformVersion?: number;
}

interface Woff2Opts {
	readonly flavor?: number;
	/** Override the compressedSize header field (corruption tests). */
	readonly compressedSize?: number;
	/** Raw compressed bytes instead of brotliCompressSync(body). */
	readonly compressed?: readonly number[];
	/** Truncate the final file to this many bytes. */
	readonly truncate?: number;
	/** Extra trailing bytes after the compressed stream. */
	readonly trailing?: readonly number[];
}

const woff2Transformed = (name: string, version: number) =>
	name === "glyf" || name === "loca" ? version !== 3 : version !== 0;

const woff2 = (tables: readonly Woff2TableSpec[], opts: Woff2Opts = {}): Uint8Array => {
	const sorted = [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const dir: number[] = [];
	const body: number[] = [];
	for (const t of sorted) {
		const known = WOFF2_KNOWN_TAG_INDEX[t.name];
		const version = t.transformVersion ?? 0;
		dir.push((version << 6) | (known ?? 0x3f));
		if (known === undefined) dir.push(...tag(t.name)); // custom tag
		dir.push(...base128(t.origLength ?? t.stored.length));
		if (woff2Transformed(t.name, version)) dir.push(...base128(t.stored.length));
		for (const b of t.stored) body.push(b);
	}
	const compressed = [...(opts.compressed ?? [...brotliCompressSync(new Uint8Array(body))])];
	const compressedSize = opts.compressedSize ?? compressed.length;
	const total = 48 + dir.length + compressed.length + (opts.trailing?.length ?? 0);
	const out = new Uint8Array([
		...tag("wOF2"),
		...u32(opts.flavor ?? 0x00010000),
		...u32(total),
		...u16(sorted.length),
		...u16(0),
		...u32(body.length),
		...u32(compressedSize),
		...u16(1),
		...u16(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...dir,
		...compressed,
		...(opts.trailing ?? []),
	]);
	return opts.truncate === undefined ? out : out.slice(0, opts.truncate);
};

// ---------- transformed glyf payload builder ----------

/**
 * A point in a simple glyph. `dx`/`dy` are deltas from the previous
 * point; the default encoder uses the 4-byte transform form (always
 * valid). `raw` supplies a hand-picked transform flag byte + triplet
 * bytes for branch-coverage cases.
 */
type PointSpec =
	| { readonly dx: number; readonly dy: number; readonly on?: boolean }
	| { readonly raw: { readonly flag: number; readonly bytes: readonly number[] } };

interface ComponentSpec {
	readonly glyphId: number;
	readonly argsAreXY: boolean;
	readonly a1: number;
	readonly a2: number;
	/** Force word-sized args (default: inferred from value range). */
	readonly argWords?: boolean;
	/** Extra preserved flag bits (ROUND_XY_TO_GRID etc.). */
	readonly keepFlags?: number;
	/** Transform: file-order F2DOT14 ints + which flag to emit. */
	readonly transform?:
		| { readonly kind: "scale"; readonly s: number }
		| { readonly kind: "xyscale"; readonly x: number; readonly y: number }
		| { readonly kind: "2x2"; readonly v: readonly [number, number, number, number] };
}

type GlyphSpec =
	| { readonly kind: "empty" }
	| {
			readonly kind: "simple";
			readonly contours: readonly {
				readonly points: readonly PointSpec[];
				readonly instructions?: readonly number[];
			}[];
			/** Stored bbox override; omit → computed from coords. */
			readonly bbox?: readonly [number, number, number, number];
	  }
	| {
			readonly kind: "composite";
			readonly components: readonly ComponentSpec[];
			readonly instructions?: readonly number[];
			readonly bbox?: readonly [number, number, number, number];
	  };

interface GlyfBuild {
	readonly payload: Uint8Array;
	readonly numGlyphs: number;
}

/** The 4-byte transform point encoding: flag 124..127 carries the
 * dx/dy sign bits (bit0 = x positive, bit1 = y positive), followed by
 * |dx| and |dy| as u16. Bit7 of the flag byte marks OFF-curve points. */
const encPoint4 = (dx: number, dy: number, on = true): { flag: number; bytes: number[] } => ({
	flag: (124 + (dx >= 0 ? 1 : 0) + (dy >= 0 ? 2 : 0)) | (on ? 0 : 0x80),
	bytes: [...u16(Math.abs(dx)), ...u16(Math.abs(dy))],
});

const ARG_WORDS = 0x0001;
const ARG_XY = 0x0002;
const MORE_COMPONENTS = 0x0020;
const SCALE_FLAG = 0x0008;
const X_AND_Y_SCALE_FLAG = 0x0040;
const TWO_BY_TWO_FLAG = 0x0080;
const HAVE_INSTRUCTIONS_FLAG = 0x0100;

/**
 * Encode glyph specs into a WOFF2 transformed-glyf payload: the seven
 * substreams plus header, exactly as a conforming encoder would emit.
 * `opts` allows corrupting individual pieces for negative tests.
 */
const buildGlyfTransform = (
	glyphs: readonly GlyphSpec[],
	opts: {
		readonly indexFormat?: number;
		readonly optionFlags?: number;
		readonly overlap?: readonly number[];
		readonly header?: readonly number[];
		readonly trailing?: readonly number[];
		/** bbox bitmap handling: "auto" stores a bbox only for glyphs
		 * whose spec provides one (composites always need one — give
		 * them a bbox), "allStored"/"noneStored" force the bit. */
		readonly bboxMode?: "auto" | "allStored" | "noneStored";
	} = {},
): GlyfBuild => {
	const numGlyphs = glyphs.length;
	const contours: number[] = [];
	const nPoints: number[] = [];
	const flags: number[] = [];
	const glyphStream: number[] = [];
	const compositeStream: number[] = [];
	const instructionStream: number[] = [];
	const bboxBitmap = new Array<number>(((numGlyphs + 31) >> 5) << 2).fill(0);
	const bboxRecords: number[] = [];
	const mode = opts.bboxMode ?? "auto";
	const markBBox = (i: number, bbox: readonly [number, number, number, number]) => {
		if (mode === "noneStored") return;
		bboxBitmap[i >> 3] = bboxBitmap[i >> 3]! | (0x80 >> (i & 7));
		bboxRecords.push(...i16(bbox[0]), ...i16(bbox[1]), ...i16(bbox[2]), ...i16(bbox[3]));
	};
	glyphs.forEach((g, i) => {
		if (g.kind === "empty") {
			contours.push(...i16(0));
			return;
		}
		if (g.kind === "composite") {
			contours.push(...i16(-1));
			const last = g.components.length - 1;
			for (let k = 0; k < g.components.length; k++) {
				const c = g.components[k]!;
				let f = c.keepFlags ?? 0;
				if (k !== last) f |= MORE_COMPONENTS;
				if (g.instructions !== undefined && k === last) f |= HAVE_INSTRUCTIONS_FLAG;
				// Args: infer word-size like a real encoder would.
				const words =
					c.argWords ??
					(c.argsAreXY
						? !(c.a1 >= -128 && c.a1 <= 127 && c.a2 >= -128 && c.a2 <= 127)
						: !(c.a1 <= 255 && c.a2 <= 255));
				if (c.argsAreXY) f |= ARG_XY;
				if (words) f |= ARG_WORDS;
				if (c.transform !== undefined) {
					f |=
						c.transform.kind === "scale"
							? SCALE_FLAG
							: c.transform.kind === "xyscale"
								? X_AND_Y_SCALE_FLAG
								: TWO_BY_TWO_FLAG;
				}
				// Record order: flags, glyphID, args, transform.
				compositeStream.push(...u16(f), ...u16(c.glyphId));
				if (c.argsAreXY) {
					if (words) compositeStream.push(...i16(c.a1), ...i16(c.a2));
					else compositeStream.push(...i8(c.a1), ...i8(c.a2));
				} else if (words) {
					compositeStream.push(...u16(c.a1), ...u16(c.a2));
				} else {
					compositeStream.push(c.a1 & 0xff, c.a2 & 0xff);
				}
				if (c.transform !== undefined) {
					if (c.transform.kind === "scale") {
						compositeStream.push(...i16(c.transform.s));
					} else if (c.transform.kind === "xyscale") {
						compositeStream.push(...i16(c.transform.x), ...i16(c.transform.y));
					} else {
						compositeStream.push(...c.transform.v.flatMap(i16));
					}
				}
			}
			// Composites MUST carry a stored bbox.
			markBBox(i, g.bbox ?? [0, 0, 0, 0]);
			if (g.instructions !== undefined) {
				glyphStream.push(...enc255(g.instructions.length));
				instructionStream.push(...g.instructions);
			}
			return;
		}
		// simple
		contours.push(...i16(g.contours.length));
		for (const c of g.contours) {
			nPoints.push(...enc255(c.points.length));
			for (const p of c.points) {
				const e = "raw" in p ? p.raw : encPoint4(p.dx, p.dy, p.on ?? true);
				flags.push(e.flag);
				glyphStream.push(...e.bytes);
			}
		}
		// Instructions: one length-prefixed blob per simple glyph, taken
		// from the FIRST contour's spec (builder convenience).
		const instr = g.contours[0]?.instructions ?? [];
		glyphStream.push(...enc255(instr.length));
		instructionStream.push(...instr);
		if (g.bbox !== undefined || mode === "allStored") {
			markBBox(i, g.bbox ?? [0, 0, 0, 0]);
		}
	});
	const streams = [
		contours,
		nPoints,
		flags,
		glyphStream,
		compositeStream,
		[...bboxBitmap, ...bboxRecords],
		instructionStream,
	];
	const sizes = streams.map((s) => s.length);
	const header = opts.header ?? [
		...u16(0),
		...u16(opts.optionFlags ?? 0),
		...u16(numGlyphs),
		...u16(opts.indexFormat ?? 0),
		...sizes.flatMap(u32),
	];
	const overlap =
		(opts.optionFlags ?? 0) & 1
			? (opts.overlap ?? new Array<number>((numGlyphs + 7) >> 3).fill(0))
			: [];
	return {
		payload: new Uint8Array([...header, ...streams.flat(), ...overlap, ...(opts.trailing ?? [])]),
		numGlyphs,
	};
};

// ---------- sfnt inspection helpers ----------

interface SfntTable {
	readonly tag: string;
	readonly data: Uint8Array;
}

const sfntTables = (bytes: Uint8Array): SfntTable[] => {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const num = v.getUint16(4);
	const out: SfntTable[] = [];
	for (let i = 0; i < num; i++) {
		const o = 12 + i * 16;
		const t = String.fromCharCode(
			v.getUint8(o),
			v.getUint8(o + 1),
			v.getUint8(o + 2),
			v.getUint8(o + 3),
		);
		const off = v.getUint32(o + 8);
		const len = v.getUint32(o + 12);
		out.push({ tag: t, data: bytes.subarray(off, off + len) });
	}
	return out;
};

const tableBytes = (sfnt: Uint8Array, t: string): Uint8Array => {
	const found = sfntTables(sfnt).find((x) => x.tag === t);
	if (found === undefined) throw new Error(`missing table ${t}`);
	return found.data;
};

/** Big-endian u32 word sum, zero-padded — mirrors the sfnt checksum. */
const checksum = (data: Uint8Array): number => {
	let sum = 0;
	for (let i = 0; i < data.length; i += 4) {
		let word = 0;
		for (let j = 0; j < 4; j++) word = word * 256 + (i + j < data.length ? data[i + j]! : 0);
		sum = (sum + word) >>> 0;
	}
	return sum;
};

/** Parse a simple (non-composite) glyf glyph's coordinates. Our
 * encoder never emits flag-repeat, but the parser tolerates it. */
const parseSimpleGlyph = (data: Uint8Array) => {
	const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const numberOfContours = v.getInt16(0);
	const xMin = v.getInt16(2);
	const yMin = v.getInt16(4);
	const xMax = v.getInt16(6);
	const yMax = v.getInt16(8);
	let pos = 10;
	let last = -1;
	for (let i = 0; i < numberOfContours; i++) {
		last = v.getUint16(pos);
		pos += 2;
	}
	const nPoints = last + 1;
	const instrLen = v.getUint16(pos);
	pos += 2;
	const instructions = data.slice(pos, pos + instrLen);
	pos += instrLen;
	const flags: number[] = [];
	while (flags.length < nPoints) {
		const f = data[pos]!;
		pos++;
		flags.push(f);
		if ((f & 0x08) !== 0) {
			const repeat = data[pos]!;
			pos++;
			for (let r = 0; r < repeat; r++) flags.push(f);
		}
	}
	const readAxis = (shortBit: number, sameBit: number): number[] => {
		const out: number[] = [];
		for (const f of flags) {
			if ((f & shortBit) !== 0) {
				const b = data[pos]!;
				pos++;
				out.push((f & sameBit) !== 0 ? b : -b);
			} else if ((f & sameBit) === 0) {
				out.push(v.getInt16(pos));
				pos += 2;
			} else {
				out.push(0);
			}
		}
		return out;
	};
	const dxs = readAxis(0x02, 0x10);
	const dys = readAxis(0x04, 0x20);
	const xs: number[] = [];
	const ys: number[] = [];
	let x = 0;
	let y = 0;
	for (let i = 0; i < nPoints; i++) {
		x += dxs[i]!;
		y += dys[i]!;
		xs.push(x);
		ys.push(y);
	}
	return { numberOfContours, xMin, yMin, xMax, yMax, flags, xs, ys, instructions };
};

// ---------- WOFF2 wrappers around the glyf builder ----------

const HEAD_54 = new Array<number>(54).fill(0);
HEAD_54[8] = 0; // checkSumAdjustment area (zeroed anyway)
// indexToLocFormat at offset 50 → keep 0 (short loca) unless overridden.
const headTable = (indexToLocFormat = 0, length = 54): number[] => {
	const h = new Array<number>(length).fill(0);
	if (length >= 52) {
		h[50] = (indexToLocFormat >> 8) & 0xff;
		h[51] = indexToLocFormat & 0xff;
	}
	return h;
};

const HHEA_36 = new Array<number>(36).fill(0);
const hheaTable = (numberOfHMetrics: number): number[] => {
	const h = [...HHEA_36];
	h[34] = (numberOfHMetrics >> 8) & 0xff;
	h[35] = numberOfHMetrics & 0xff;
	return h;
};

/** WOFF2 with transformed glyf+loca built from glyph specs, plus any
 * extra verbatim tables. `glyfOpts` forwards to buildGlyfTransform. */
const glyfWoff2 = (
	glyphs: readonly GlyphSpec[],
	extra: readonly Woff2TableSpec[] = [],
	glyfOpts: Parameters<typeof buildGlyfTransform>[1] = {},
): Uint8Array => {
	const { payload } = buildGlyfTransform(glyphs, glyfOpts);
	return woff2([
		{ name: "glyf", stored: [...payload], origLength: 1768 },
		{ name: "loca", stored: [], origLength: 50 },
		...extra,
	]);
};

const MINIMAL_TABLES: Woff2TableSpec[] = [
	{ name: "head", stored: headTable() },
	{ name: "hhea", stored: hheaTable(1) },
	{ name: "maxp", stored: new Array<number>(32).fill(0) },
	{ name: "cmap", stored: [0, 0, 0, 0] },
];

describe("woff2ToSfnt — real fixtures", () => {
	it("reconstructs the katex WOFF2 fixture to a valid sfnt", async () => {
		const sfnt = await woff2ToSfnt(fixtureWoff2("katex-size3.woff2"));
		expect(sfnt).not.toBeNull();
		const tags = sfntTables(sfnt!)
			.map((t) => t.tag)
			.sort();
		expect(tags).toEqual([
			"OS/2",
			"cmap",
			"cvt ",
			"fpgm",
			"gasp",
			"glyf",
			"head",
			"hhea",
			"hmtx",
			"loca",
			"maxp",
			"name",
			"post",
			"prep",
		]);
		// checkSumAdjustment makes the whole-font checksum the magic value.
		expect(checksum(sfnt!)).toBe(0xb1b0afba);
		// Directory is sorted by tag (OTS requirement).
		const order = sfntTables(sfnt!).map((t) => t.tag);
		expect(order).toEqual([...order].sort());
	});

	it("reconstructs a WOFF2 with 172 composite glyphs losslessly", async () => {
		const sfnt = await woff2ToSfnt(fixtureWoff2("libsans-small.woff2"));
		expect(sfnt).not.toBeNull();
		const glyf = tableBytes(sfnt!, "glyf");
		const loca = tableBytes(sfnt!, "loca");
		const head = tableBytes(sfnt!, "head");
		const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
		expect(v.getInt16(50)).toBe(0); // short loca preserved
		// 359 glyphs → 360 loca entries × 2 bytes.
		expect(loca.byteLength).toBe(360 * 2);
		// Every composite glyph starts with numberOfContours = -1.
		const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
		const gv = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
		let composites = 0;
		for (let i = 0; i < 359; i++) {
			const s = lv.getUint16(i * 2) * 2;
			const e = lv.getUint16((i + 1) * 2) * 2;
			if (e > s && gv.getInt16(s) === -1) composites++;
		}
		expect(composites).toBe(172);
	});

	it("reconstructs a CFF/OTF WOFF2 (no glyf/loca) with OTTO flavor", async () => {
		const sfnt = await woff2ToSfnt(
			woff2(
				[
					{ name: "CFF ", stored: [1, 2, 3, 4] },
					{ name: "OS/2", stored: [0, 1] },
					...MINIMAL_TABLES,
				],
				{ flavor: 0x4f54544f }, // "OTTO"
			),
		);
		expect(sfnt).not.toBeNull();
		expect(String.fromCharCode(...sfnt!.slice(0, 4))).toBe("OTTO");
		expect(findTable(sfnt!, "CFF ")).not.toBeNull();
		expect(findTable(sfnt!, "glyf")).toBeNull();
	});
});

describe("woff2ToSfnt — container/directory rejection", () => {
	it("rejects short headers, bad signatures and empty directories", async () => {
		expect(await woff2ToSfnt(new Uint8Array(10))).toBeNull();
		expect(
			await woff2ToSfnt(new Uint8Array([0x77, 0x4f, 0x46, 0x46, ...new Array(60).fill(0)])),
		).toBeNull();
		// numTables = 0.
		const zero = new Uint8Array(48);
		zero.set([0x77, 0x4f, 0x46, 0x32], 0);
		expect(await woff2ToSfnt(zero)).toBeNull();
	});

	it("rejects truncated directories and bad base128 lengths", async () => {
		// File truncated in the middle of the table directory.
		const one = woff2([{ name: "cmap", stored: [1, 2, 3] }]);
		expect(await woff2ToSfnt(one.slice(0, 49))).toBeNull();
		// flags byte then EOF → readBase128 sees pos >= end.
		const bare = new Uint8Array(49);
		bare.set([0x77, 0x4f, 0x46, 0x32], 0);
		new DataView(bare.buffer).setUint16(12, 1);
		bare[48] = 0; // cmap flags, then nothing
		expect(await woff2ToSfnt(bare)).toBeNull();
		// Leading-zero base128 (0x80) is banned.
		const lz = new Uint8Array(50);
		lz.set([0x77, 0x4f, 0x46, 0x32], 0);
		const lv = new DataView(lz.buffer);
		lv.setUint16(12, 1);
		lz[48] = 0;
		lz[49] = 0x80;
		expect(await woff2ToSfnt(lz)).toBeNull();
	});

	it("rejects duplicate tags, unknown transforms and bad loca transformLength", async () => {
		// Duplicate "cmap" entries.
		const dup = woff2([
			{ name: "cmap", stored: [1] },
			{ name: "cmap", stored: [2] },
		]);
		expect(await woff2ToSfnt(dup)).toBeNull();
		// cmap with transformVersion 1 → unknown transform.
		const badTransform = woff2([{ name: "cmap", stored: [1, 2], transformVersion: 1 }]);
		expect(await woff2ToSfnt(badTransform)).toBeNull();
		// Transformed loca must have transformLength 0 — give it bytes.
		const badLoca = woff2([
			{ name: "glyf", stored: [0], origLength: 10 },
			{ name: "loca", stored: [9], origLength: 4 },
		]);
		expect(await woff2ToSfnt(badLoca)).toBeNull();
	});

	it("rejects oversized claims, truncated compressed data and bad brotli", async () => {
		// origLength claims > 64MB decompressed → cap before decompress.
		const bomb = woff2([{ name: "cmap", stored: [1], origLength: 128 * 1024 * 1024 }]);
		expect(await woff2ToSfnt(bomb)).toBeNull();
		// compressedSize beyond the buffer.
		const over = woff2([{ name: "cmap", stored: [1, 2, 3] }], { compressedSize: 0xffff });
		expect(await woff2ToSfnt(over)).toBeNull();
		// Garbage "brotli" stream.
		const garbage = woff2([{ name: "cmap", stored: [1, 2, 3] }], {
			compressed: [0xab, 0xcd, 0xef, 0x01, 0x02],
		});
		expect(await woff2ToSfnt(garbage)).toBeNull();
		// Decompressed size disagrees with the directory (origLength lie).
		const lie = woff2([{ name: "cmap", stored: [1, 2, 3], origLength: 99 }]);
		expect(await woff2ToSfnt(lie)).toBeNull();
	});

	it("rejects glyf/loca transform pairing violations", async () => {
		const { payload } = buildGlyfTransform([{ kind: "empty" }]);
		// glyf transformed, loca absent.
		expect(
			await woff2ToSfnt(woff2([{ name: "glyf", stored: [...payload], origLength: 10 }])),
		).toBeNull();
		// loca transformed (v0), glyf absent.
		expect(await woff2ToSfnt(woff2([{ name: "loca", stored: [], origLength: 4 }]))).toBeNull();
		// glyf transformed + loca null-transform (v3) → mismatch.
		expect(
			await woff2ToSfnt(
				woff2([
					{ name: "glyf", stored: [...payload], origLength: 10 },
					{ name: "loca", stored: [0, 0], transformVersion: 3, origLength: 4 },
				]),
			),
		).toBeNull();
	});
});

describe("woff2ToSfnt — transformed glyf decode", () => {
	const wrap = (payload: Uint8Array, extra: readonly Woff2TableSpec[] = MINIMAL_TABLES) =>
		woff2([
			{ name: "glyf", stored: [...payload], origLength: 100 },
			{ name: "loca", stored: [], origLength: 8 },
			...extra,
		]);

	it("decodes empty, simple and composite glyphs and emits valid sfnt", async () => {
		const glyphs: GlyphSpec[] = [
			{ kind: "empty" },
			{
				kind: "simple",
				contours: [
					{
						points: [
							{ raw: { flag: 0x00, bytes: [5] } }, // f=0: dx=0 dy=-5
							{ raw: { flag: 0x01, bytes: [44] } }, // f=1: dx=0 dy=+44
							{ raw: { flag: 0x8a, bytes: [7] } }, // f=10 off-curve dx=-7
							{ raw: { flag: 0x0b, bytes: [9] } }, // f=11 dx=+9
							{ raw: { flag: 0x17, bytes: [0x21] } }, // f=23 dx=+3 dy=+2
							{ raw: { flag: 0x56, bytes: [3, 5] } }, // f=86 dx=-4 dy=+6
							{ raw: { flag: 0x78, bytes: [16, 0x41, 44] } }, // f=120 dx=-260 dy=-300
							{ raw: { flag: 0x7d, bytes: [3, 232, 7, 208] } }, // f=125 dx=+1000 dy=-2000
							{ raw: { flag: 0x00, bytes: [0] } }, // f=0 dx=0 dy=0
						],
						instructions: [1, 2],
					},
				],
				bbox: [-259, -2253, 741, 47],
			},
			{
				kind: "simple",
				contours: [
					{
						points: [
							{ dx: 10, dy: 20 },
							{ dx: -10, dy: -20 },
							{ dx: 0, dy: 0 },
						],
					},
				],
			},
			{
				kind: "composite",
				components: [
					{
						glyphId: 1,
						argsAreXY: true,
						a1: 300,
						a2: -200,
						argWords: true,
						keepFlags: 0x0004 | 0x0200,
					},
					{
						glyphId: 2,
						argsAreXY: true,
						a1: -5,
						a2: 7,
						keepFlags: 0x0010 | 0x0800,
						transform: { kind: "2x2", v: [16384, 0, 8192, 16384] },
					},
				],
				instructions: [0x2a],
				bbox: [0, 0, 500, 500],
			},
			{
				kind: "composite",
				components: [
					{ glyphId: 0, argsAreXY: false, a1: 3, a2: 4 },
					{ glyphId: 1, argsAreXY: false, a1: 300, a2: 400 },
					{ glyphId: 0, argsAreXY: true, a1: -5, a2: 7, transform: { kind: "scale", s: 16384 } },
					{
						glyphId: 0,
						argsAreXY: true,
						a1: 300,
						a2: -200,
						transform: { kind: "xyscale", x: 8192, y: 16384 },
					},
					{
						glyphId: 0,
						argsAreXY: true,
						a1: 1,
						a2: -1,
						transform: { kind: "xyscale", x: 16384, y: 16384 },
					},
					{
						glyphId: 0,
						argsAreXY: false,
						a1: 1000,
						a2: 1000,
						transform: { kind: "2x2", v: [16384, 4096, 0, 16384] },
					},
					{
						glyphId: 0,
						argsAreXY: true,
						a1: 0,
						a2: 0,
						transform: { kind: "2x2", v: [16384, 0, 8192, 16384] },
					},
					{
						glyphId: 0,
						argsAreXY: false,
						a1: 1,
						a2: 2,
						transform: { kind: "2x2", v: [8192, 0, 0, 16384] },
					},
					{ glyphId: 0, argsAreXY: true, a1: -300, a2: 300 },
				],
				bbox: [0, 0, 10, 10],
			},
		];
		const sfnt = await woff2ToSfnt(
			glyfWoff2(glyphs, MINIMAL_TABLES, { optionFlags: 1, overlap: [0x40] }),
		);
		expect(sfnt).not.toBeNull();
		// Whole-font checksum is the sfnt magic value.
		expect(checksum(sfnt!)).toBe(0xb1b0afba);
		const glyf = tableBytes(sfnt!, "glyf");
		const loca = tableBytes(sfnt!, "loca");
		const head = tableBytes(sfnt!, "head");
		expect(new DataView(head.buffer).getInt16(50)).toBe(0); // short loca
		// loca: numGlyphs+1 = 6 entries × u16 (offset/2).
		expect(loca.byteLength).toBe(12);
		const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
		const gv = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
		// glyph0 empty → zero-length slice.
		expect(lv.getUint16(0)).toBe(lv.getUint16(2));
		// glyph1: parse the simple glyph and verify coordinates.
		const g1off = lv.getUint16(2) * 2;
		const g1end = lv.getUint16(4) * 2;
		const g1 = parseSimpleGlyph(glyf.slice(g1off, g1end));
		expect(g1.numberOfContours).toBe(1);
		// overlapSimple set on first flag (overlap bitmap bit for glyph1).
		expect(g1.flags[0]! & 0x40).toBe(0x40);
		// First point on-curve (bit0), coordinates match the deltas.
		expect(g1.flags[0]! & 0x01).toBe(0x01);
		expect(g1.xs[0]).toBe(0);
		expect(g1.ys[0]).toBe(-5);
		expect(g1.xs[8]).toBe(741);
		expect(g1.ys[8]).toBe(-2253);
		expect([...g1.instructions]).toEqual([1, 2]);
		// glyph3 composite: header numberOfContours = -1.
		const g3off = lv.getUint16(6) * 2;
		expect(gv.getInt16(g3off)).toBe(-1);
	});

	it("emits long loca and patches head when indexFormat=1", async () => {
		const sfnt = await woff2ToSfnt(
			glyfWoff2([{ kind: "empty" }], MINIMAL_TABLES, { indexFormat: 1 }),
		);
		expect(sfnt).not.toBeNull();
		const loca = tableBytes(sfnt!, "loca");
		expect(loca.byteLength).toBe(8); // 2 entries × u32
		expect(new DataView(tableBytes(sfnt!, "head").buffer).getInt16(50)).toBe(1);
	});

	it("falls back to long loca when short cannot hold the offsets", async () => {
		// ~30k points → compiled glyph > 0x20000 bytes → short loca overflows.
		const points = Array.from({ length: 30000 }, (_, i) => ({
			dx: i % 2 === 0 ? 300 : -300,
			dy: i % 2 === 0 ? 300 : -300,
		}));
		const sfnt = await woff2ToSfnt(
			glyfWoff2([{ kind: "simple", contours: [{ points }] }], MINIMAL_TABLES, { indexFormat: 0 }),
		);
		expect(sfnt).not.toBeNull();
		expect(tableBytes(sfnt!, "loca").byteLength).toBe(8);
		expect(new DataView(tableBytes(sfnt!, "head").buffer).getInt16(50)).toBe(1);
	});

	it("writes a single pad byte for an all-empty font", async () => {
		const sfnt = await woff2ToSfnt(
			glyfWoff2([{ kind: "empty" }, { kind: "empty" }], MINIMAL_TABLES),
		);
		expect(sfnt).not.toBeNull();
		expect(tableBytes(sfnt!, "glyf").byteLength).toBe(1);
		expect(tableBytes(sfnt!, "loca").byteLength).toBe(6); // 3 × u16 zeros
	});

	it("rejects malformed glyf transform payloads", async () => {
		const good = buildGlyfTransform([{ kind: "empty" }]).payload;
		const cases: readonly (readonly number[])[] = [
			[...good.slice(0, 10)], // shorter than the 36-byte header
			// stream sizes sum beyond the payload
			[
				...buildGlyfTransform([{ kind: "empty" }], {
					header: [
						...u16(0),
						...u16(0),
						...u16(1),
						...u16(0),
						...u32(0),
						...u32(0),
						...u32(0),
						...u32(0),
						...u32(0),
						...u32(0),
						...u32(999),
					],
				}).payload.slice(0, -1),
			],
			// numGlyphs*2 exceeds nContourStream
			[
				...buildGlyfTransform([{ kind: "empty" }], {
					header: [
						...u16(0),
						...u16(0),
						...u16(5),
						...u16(0),
						...u32(2),
						...u32(0),
						...u32(0),
						...u32(0),
						...u32(0),
						...u32(0),
						...u32(0),
					],
				}).payload,
			],
			// trailing garbage breaks the exact-size check
			[...good, 0xaa],
		];
		for (const payload of cases) {
			expect(await woff2ToSfnt(wrap(new Uint8Array(payload)))).toBeNull();
		}
	});

	it("rejects corrupt contour counts and stream truncations", async () => {
		// nContours < -1.
		const neg = buildGlyfTransform([{ kind: "empty" }], {
			header: [
				...u16(0),
				...u16(0),
				...u16(1),
				...u16(0),
				...i16(-2).map((b) => b & 0xff),
				...u32(0),
				...u32(0),
				...u32(0),
				...u32(0),
				...u32(0),
				...u32(0),
			],
		});
		// nContour stream carries -2 as int16 BE = 0xFFFE.
		const negPayload = new Uint8Array(neg.payload);
		negPayload.set([0xff, 0xfe], 36);
		expect(await woff2ToSfnt(wrap(negPayload))).toBeNull();
		// ptsOfContour = 0 → endPoint stays -1.
		const zeroPts = buildGlyfTransform([
			{ kind: "simple", contours: [{ points: [{ dx: 1, dy: 1 }] }] },
		]);
		// Locate nPointsStream byte (after header+contour int16) and zero it.
		const zp = new Uint8Array(zeroPts.payload);
		// header 36 + contours 2 = offset 38 → nPoints[0]
		zp[38] = 0;
		expect(await woff2ToSfnt(wrap(zp))).toBeNull();
		// endPoint > 0xffff: two contours of 40000 points each.
		const big = buildGlyfTransform([
			{ kind: "simple", contours: [{ points: [] }, { points: [] }] },
		]);
		const bp = new Uint8Array(big.payload);
		// contours: 2 int16 (=2), nPointsStream at offset 38: two enc255(40000)
		bp.set([...enc255(40000), ...enc255(40000)], 38);
		// header stream sizes: nPoints size field at offset 12 — set to 6.
		const bv = new DataView(bp.buffer);
		bv.setUint32(12, 6);
		expect(await woff2ToSfnt(wrap(bp))).toBeNull();
	});
});

describe("woff2ToSfnt — transformed hmtx", () => {
	/** WOFF2 with transformed glyf+loca+hmtx; hmtx payload is the
	 * compressed substream: flags u8 + advanceWidths u16[] +
	 * optional side-bearing arrays. */
	const hmtxWoff2 = (
		glyphs: readonly GlyphSpec[],
		hmtxStored: readonly number[],
		numHMetrics: number,
		extra: readonly Woff2TableSpec[] = [],
		glyfOpts: Parameters<typeof buildGlyfTransform>[1] = {},
	): Uint8Array => {
		const { payload } = buildGlyfTransform(glyphs, glyfOpts);
		return woff2([
			{ name: "glyf", stored: [...payload], origLength: 200 },
			{ name: "hhea", stored: hheaTable(numHMetrics) },
			{ name: "hmtx", stored: hmtxStored, origLength: hmtxStored.length, transformVersion: 1 },
			{ name: "loca", stored: [], origLength: 16 },
			...extra.filter((t) => t.name !== "hhea"),
		]);
	};

	it("rebuilds hmtx with omitted side bearings from glyph x-mins", async () => {
		// 3 glyphs: empty, simple box with xMin=3, empty. numHMetrics=2.
		// Transform hmtx: one flags byte — bit0 set means the per-glyph
		// lsb array is omitted (synthesized from xMins); bit1 clear means
		// the trailing leftSideBearing array IS present.
		const glyphs: GlyphSpec[] = [
			{ kind: "empty" },
			{
				kind: "simple",
				contours: [
					{
						points: [
							{ dx: 3, dy: 0 },
							{ dx: 10, dy: 0 },
							{ dx: 0, dy: 20 },
							{ dx: -10, dy: 0 },
						],
					},
				],
			},
			{ kind: "empty" },
		];
		const { numGlyphs } = buildGlyfTransform(glyphs);
		expect(numGlyphs).toBe(3);
		// flags=1 → no lsb array; advances[2]; trailing lsb[1] for glyph2.
		const hmtx = [1, ...u16(500), ...u16(600), ...i16(9)];
		const sfnt = await woff2ToSfnt(
			hmtxWoff2(glyphs, hmtx, 2, [
				{ name: "head", stored: headTable() },
				{ name: "maxp", stored: new Array(32).fill(0) },
				{ name: "cmap", stored: [0] },
			]),
		);
		expect(sfnt).not.toBeNull();
		const h = tableBytes(sfnt!, "hmtx");
		// Standard hmtx: nHM=2 → 2×(u16 advance + i16 lsb) + 1×i16 lsb.
		const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
		expect(h.byteLength).toBe(10);
		expect(v.getUint16(0)).toBe(500);
		expect(v.getInt16(2)).toBe(0); // glyph0 lsb ← xMin of empty glyph
		expect(v.getUint16(4)).toBe(600);
		expect(v.getInt16(6)).toBe(3); // glyph1 lsb ← xMin = 3
		// glyph2: advance repeats 600 implicitly; lsb = trailing value 9.
		expect(v.getInt16(8)).toBe(9);
	});

	it("rejects malformed transformed hmtx", async () => {
		const glyphs = [{ kind: "empty" } as const];
		const base = { name: "head", stored: headTable() } as const;
		const bad: readonly (readonly number[])[] = [
			[], // empty
			[0xfc, 1], // reserved flag bits
			[3, 1], // both sidebearing arrays omitted → invalid
			[1, 0], // advanceWidth truncated
			[0, 0, 1], // flags=0 → lsb+trailing arrays expected, data short
			[1, ...u16(500), 9], // trailing garbage
		];
		for (const hmtx of bad) {
			expect(await woff2ToSfnt(hmtxWoff2(glyphs, hmtx, 1, [base]))).toBeNull();
		}
		// numberOfHMetrics = 0 → clamped below 1.
		expect(await woff2ToSfnt(hmtxWoff2(glyphs, [1, ...u16(500)], 0, [base]))).toBeNull();
		// Missing hhea.
		expect(
			await woff2ToSfnt(
				woff2([
					{ name: "glyf", stored: [...buildGlyfTransform(glyphs).payload], origLength: 50 },
					{ name: "hmtx", stored: [1, ...u16(500)], origLength: 3, transformVersion: 1 },
					{ name: "loca", stored: [], origLength: 4 },
					base,
				]),
			),
		).toBeNull();
	});
});

describe("woff2ToSfnt — transformed hmtx over raw glyf", () => {
	it("reads x-mins from raw glyf via short loca", async () => {
		// glyf: glyph0 = 10-byte header with xMin=5; glyph1 empty.
		const glyf = [
			...i16(0), // numberOfContours=0 (still counts as data)
			...i16(5),
			...i16(-3),
			...i16(9),
			...i16(12),
		];
		const loca = [...u16(0), ...u16(5), ...u16(5)]; // offsets/2: [0,5,5]
		// flags=1 → per-glyph lsb array omitted (xMins used); the
		// leftSideBearing array for glyphs past nHM is present.
		const hmtx = [1, ...u16(400), ...i16(7)];
		const sfnt = await woff2ToSfnt(
			woff2([
				{ name: "glyf", stored: glyf, transformVersion: 3, origLength: glyf.length },
				{ name: "head", stored: headTable(0), origLength: 54 },
				{ name: "hhea", stored: hheaTable(1), origLength: 36 },
				{ name: "hmtx", stored: hmtx, origLength: hmtx.length, transformVersion: 1 },
				{ name: "loca", stored: loca, transformVersion: 3, origLength: loca.length },
				{ name: "cmap", stored: [0], origLength: 1 },
			]),
		);
		expect(sfnt).not.toBeNull();
		const h = tableBytes(sfnt!, "hmtx");
		const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
		// nHM=1: glyph0 advance+lsb(xMin=5), glyph1 lsb only? trailing i16.
		expect(v.getUint16(0)).toBe(400);
		expect(v.getInt16(2)).toBe(5);
		expect(v.getInt16(4)).toBe(7); // glyph1 lsb = trailing array value
	});

	it("keeps explicit lsbs and synthesizes trailing bearings (flags=2)", async () => {
		const glyf = [...i16(0), ...i16(5), ...i16(-3), ...i16(9), ...i16(12)];
		const loca = [...u16(0), ...u16(5), ...u16(5)];
		// flags=2 → lsb array present, leftSideBearing array omitted
		// (trailing bearings come from xMins).
		const hmtx = [2, ...u16(400), ...i16(3)];
		const sfnt = await woff2ToSfnt(
			woff2([
				{ name: "glyf", stored: glyf, transformVersion: 3, origLength: glyf.length },
				{ name: "head", stored: headTable(0), origLength: 54 },
				{ name: "hhea", stored: hheaTable(1), origLength: 36 },
				{ name: "hmtx", stored: hmtx, origLength: hmtx.length, transformVersion: 1 },
				{ name: "loca", stored: loca, transformVersion: 3, origLength: loca.length },
				{ name: "cmap", stored: [0], origLength: 1 },
			]),
		);
		expect(sfnt).not.toBeNull();
		const h = tableBytes(sfnt!, "hmtx");
		const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
		expect(v.getUint16(0)).toBe(400);
		expect(v.getInt16(2)).toBe(3); // explicit lsb for glyph0
		expect(v.getInt16(4)).toBe(0); // glyph1 trailing lsb ← xMin of empty glyph
	});

	it("rejects corrupt raw glyf/loca for hmtx reconstruction", async () => {
		const mk = (
			locaFmt: number,
			locaLen: number,
			locaBytes: number[],
			glyfBytes: number[],
			headLen = 54,
		) =>
			woff2([
				{ name: "glyf", stored: glyfBytes, transformVersion: 3, origLength: glyfBytes.length },
				{ name: "head", stored: headTable(locaFmt, headLen), origLength: headLen },
				{ name: "hhea", stored: hheaTable(1), origLength: 36 },
				{ name: "hmtx", stored: [1, ...u16(400)], origLength: 3, transformVersion: 1 },
				{
					name: "loca",
					stored: locaBytes.slice(0, locaLen),
					transformVersion: 3,
					origLength: locaLen,
				},
				{ name: "cmap", stored: [0], origLength: 1 },
			]);
		const glyf = [0, 1, ...i16(0), ...i16(0), ...i16(0), ...i16(0)];
		// indexToLocFormat=2 → invalid.
		expect(await woff2ToSfnt(mk(2, 4, [0, 0, 0, 0], glyf))).toBeNull();
		// short loca with odd/short length.
		expect(await woff2ToSfnt(mk(0, 3, [0, 0, 0], glyf))).toBeNull();
		// loca end < start.
		expect(await woff2ToSfnt(mk(0, 4, [...u16(5), ...u16(0)], glyf))).toBeNull();
		// loca end beyond glyf length.
		expect(await woff2ToSfnt(mk(0, 4, [...u16(0), ...u16(9)], [...glyf.slice(0, 10)]))).toBeNull();
		// glyph slice < 10 bytes.
		expect(await woff2ToSfnt(mk(0, 4, [...u16(0), ...u16(2)], glyf))).toBeNull();
		// long loca format works.
		const longLoca = await woff2ToSfnt(mk(1, 8, [...u32(0), ...u32(10)], glyf));
		expect(longLoca).not.toBeNull();
		// head too short for indexToLocFormat → treated as missing.
		expect(await woff2ToSfnt(mk(0, 4, [...u16(0), ...u16(5)], glyf, 40))).toBeNull();
		// hmtx transformed but no glyf at all.
		expect(
			await woff2ToSfnt(
				woff2([
					{ name: "hmtx", stored: [1, ...u16(1)], origLength: 3, transformVersion: 1 },
					{ name: "head", stored: headTable(), origLength: 54 },
					{ name: "loca", stored: [0, 0], transformVersion: 3, origLength: 4 },
					{ name: "cmap", stored: [0], origLength: 1 },
				]),
			),
		).toBeNull();
	});
});

describe("woff2ToSfnt — untransformed glyf/loca passthrough", () => {
	it("passes null-transform (v3) glyf/loca through verbatim", async () => {
		const glyf = [0, 1, ...i16(0), ...i16(1), ...i16(2), ...i16(3), ...i16(4)];
		const loca = [...u16(0), ...u16(5)];
		const sfnt = await woff2ToSfnt(
			woff2([
				{ name: "glyf", stored: glyf, transformVersion: 3, origLength: glyf.length },
				{ name: "loca", stored: loca, transformVersion: 3, origLength: loca.length },
				{ name: "head", stored: headTable(0, 40), origLength: 40 }, // short head: no adjust patch but ≥12
				{ name: "cmap", stored: [0], origLength: 1 },
			]),
		);
		expect(sfnt).not.toBeNull();
		expect(tableBytes(sfnt!, "glyf")).toEqual(new Uint8Array(glyf));
		expect(checksum(sfnt!)).toBe(0xb1b0afba);
	});

	it("rejects a bare transformed glyf with no loca sibling and vice versa", async () => {
		const { payload } = buildGlyfTransform([{ kind: "empty" }]);
		expect(
			await woff2ToSfnt(
				woff2([
					{ name: "glyf", stored: [...payload], origLength: 50 },
					{ name: "cmap", stored: [0], origLength: 1 },
				]),
			),
		).toBeNull();
		expect(
			await woff2ToSfnt(
				woff2([
					{ name: "loca", stored: [], origLength: 4 },
					{ name: "cmap", stored: [0], origLength: 1 },
				]),
			),
		).toBeNull();
	});
});

describe("woff2ToSfnt — remaining decode branches", () => {
	const wrap = (payload: Uint8Array) =>
		woff2([
			{ name: "glyf", stored: [...payload], origLength: 100 },
			{ name: "loca", stored: [], origLength: 8 },
			...MINIMAL_TABLES,
		]);

	it("rejects stream-size and position overruns", async () => {
		// First stream size claims more than the payload holds.
		const huge = new Uint8Array(48);
		huge.set(buildGlyfTransform([{ kind: "empty" }]).payload.slice(0, 40));
		new DataView(huge.buffer).setUint32(8, 0xfffffff0); // nContourStream size
		expect(await woff2ToSfnt(wrap(huge))).toBeNull();
		// bboxBitmap larger than bboxStream.
		const bm = buildGlyfTransform([
			{ kind: "empty" },
			{ kind: "empty" },
			{ kind: "empty" },
			{ kind: "empty" },
			{ kind: "empty" },
		]);
		const bmp = new Uint8Array(bm.payload);
		// numGlyphs=5 → bitmap needs 4 bytes; bboxStream = bitmap+records.
		// Shrink bboxStream size to 1 (< bitmap 4).
		new DataView(bmp.buffer).setUint32(28, 1);
		expect(await woff2ToSfnt(wrap(bmp))).toBeNull();
		// nContourStream present but < numGlyphs*2 (pos+2 > ncEnd): 1 glyph, size 1.
		const one = buildGlyfTransform([{ kind: "empty" }]);
		const ncp = new Uint8Array(one.payload);
		new DataView(ncp.buffer).setUint32(8, 1); // contour stream size = 1 byte
		expect(await woff2ToSfnt(wrap(ncp))).toBeNull();
	});

	it("rejects truncated nPoints/flags/glyph/instruction reads", async () => {
		const glyphs: GlyphSpec[] = [
			{
				kind: "simple",
				contours: [{ points: [{ dx: 1, dy: 1 }], instructions: [0xaa] }],
			},
		];
		const { payload } = buildGlyfTransform(glyphs);
		// nPointsStream: contours=1 then ptsOfContour — truncate nPoints size to 0.
		const np = new Uint8Array(payload);
		new DataView(np.buffer).setUint32(12, 0);
		expect(await woff2ToSfnt(wrap(np))).toBeNull();
		// flagStream too small for nPoints.
		const fs = new Uint8Array(payload);
		new DataView(fs.buffer).setUint32(16, 0);
		expect(await woff2ToSfnt(wrap(fs))).toBeNull();
		// glyphStream truncated mid-triplet: 1 point needs 4 bytes (4-byte
		// form) but give glyph stream size covering only 2.
		// glyphStream layout: [triplet 4B][instrLen 1B]. Set glyph size = 2.
		const gs = new Uint8Array(payload);
		new DataView(gs.buffer).setUint32(20, 2);
		expect(await woff2ToSfnt(wrap(gs))).toBeNull();
		// Simple glyph: after triplets, no instrLen byte left.
		const il = new Uint8Array(payload);
		// instrLen sits at end of glyphStream for this glyph: glyph size 4
		// (triplet only, 4-byte form) → read255 hits end → null.
		new DataView(il.buffer).setUint32(20, 4);
		expect(await woff2ToSfnt(wrap(il))).toBeNull();
		// instructions present but instructionStream too short.
		const is = new Uint8Array(payload);
		new DataView(is.buffer).setUint32(32, 0); // ins stream size (index 6 → 8+24)
		expect(await woff2ToSfnt(wrap(is))).toBeNull();
	});

	it("rejects composite-stream truncation and missing composite bbox", async () => {
		const glyphs: GlyphSpec[] = [
			{
				kind: "composite",
				components: [{ glyphId: 0, argsAreXY: true, a1: 1, a2: 2 }],
				bbox: [0, 0, 1, 1],
			},
		];
		const { payload } = buildGlyfTransform(glyphs);
		// compositeStream size 0 → flags read fails.
		const cs = new Uint8Array(payload);
		new DataView(cs.buffer).setUint32(24, 0); // comp stream index 4 → 8+16
		expect(await woff2ToSfnt(wrap(cs))).toBeNull();
		// bbox bitmap bit clear for the composite → no stored bbox → null.
		const nb = buildGlyfTransform(glyphs, { bboxMode: "noneStored" });
		expect(await woff2ToSfnt(wrap(nb.payload))).toBeNull();
	});

	it("covers read255's 253/254/255 lead-byte forms via instruction lengths", async () => {
		for (const [enc, count] of [
			[[253, 0x01, 0x2c], 300], // [253] u16=300
			[[254, 94], 600], // [254] → 506+94
			[[255, 7], 260], // [255] → 253+7
		] as const) {
			const { payload, numGlyphs } = buildGlyfTransform([
				{
					kind: "composite",
					components: [{ glyphId: 0, argsAreXY: true, a1: 0, a2: 0 }],
					instructions: new Array<number>(count).fill(0x11),
					bbox: [0, 0, 0, 0],
				},
			]);
			expect(numGlyphs).toBe(1);
			// The instrLen prefix lives in glyphStream: streams concatenate
			// nc(2)+np(0)+fl(0) → gl starts at 36+2 = 38.
			const p = new Uint8Array(payload);
			const glStart = 36 + 2; // nc stream = 2 bytes (one int16 -1)
			p.set(enc, glStart);
			const sfnt = await woff2ToSfnt(wrap(p));
			expect(sfnt).not.toBeNull();
		}
	});

	it("covers coord-overflow and bbox-truncation rejects", async () => {
		// x coordinate out of int16 range after accumulation.
		for (const [dx, dy] of [
			[40000, 0],
			[-40000, 0],
			[0, 40000],
			[0, -40000],
		] as const) {
			const { payload } = buildGlyfTransform([
				{
					kind: "simple",
					contours: [{ points: [{ dx, dy }] }],
				},
			]);
			expect(await woff2ToSfnt(wrap(payload))).toBeNull();
		}
		// Stored bbox bitmap set but bboxStream truncated.
		const { payload } = buildGlyfTransform([
			{
				kind: "simple",
				contours: [{ points: [{ dx: 1, dy: 1 }] }],
				bbox: [0, 0, 5, 5],
			},
		]);
		const p = new Uint8Array(payload);
		new DataView(p.buffer).setUint32(28, 4); // bboxStream size → bitmap only, no record
		expect(await woff2ToSfnt(wrap(p))).toBeNull();
	});

	it("covers overlap-bitmap truncation and non-simple overlap", async () => {
		const glyphs: GlyphSpec[] = [
			{ kind: "simple", contours: [{ points: [{ dx: 1, dy: 1 }] }] },
			{
				kind: "composite",
				components: [{ glyphId: 0, argsAreXY: true, a1: 0, a2: 0 }],
				bbox: [0, 0, 0, 0],
			},
		];
		// optionFlags&1 but overlap bytes missing → trailing check fails.
		const { payload } = buildGlyfTransform(glyphs, { optionFlags: 1, overlap: [] });
		expect(await woff2ToSfnt(wrap(payload))).toBeNull();
		// overlap bit set on the composite (non-simple) → ignored, still ok.
		const ok = buildGlyfTransform(glyphs, { optionFlags: 1, overlap: [0x01] });
		expect(await woff2ToSfnt(wrap(ok.payload))).not.toBeNull();
	});
});

// ---------- glyf stream surgery for targeted corruption ----------

interface GlyfStreams {
	nc: number[];
	np: number[];
	fl: number[];
	gl: number[];
	cp: number[];
	bb: number[];
	ins: number[];
	overlap: number[];
	trailing: number[];
}

const GLYF_STREAM_ORDER = ["nc", "np", "fl", "gl", "cp", "bb", "ins"] as const;

const splitGlyfStreams = (payload: Uint8Array): GlyfStreams => {
	const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const optionFlags = v.getUint16(2);
	const numGlyphs = v.getUint16(4);
	const streams = {} as Record<(typeof GLYF_STREAM_ORDER)[number], number[]>;
	let pos = 36;
	for (const name of GLYF_STREAM_ORDER) {
		const size = v.getUint32(8 + GLYF_STREAM_ORDER.indexOf(name) * 4);
		streams[name] = [...payload.subarray(pos, pos + size)];
		pos += size;
	}
	const ovLen = (optionFlags & 1) !== 0 ? (numGlyphs + 7) >> 3 : 0;
	return {
		...streams,
		overlap: [...payload.subarray(pos, pos + ovLen)],
		trailing: [...payload.subarray(pos + ovLen)],
	};
};

/** Rebuild a glyf transform payload after mutating substreams. To keep
 * the payload's exact-size invariant, any byte deficit is padded with
 * zeros onto `padStream` (default "ins" — instruction bytes beyond the
 * declared lengths are never read; pick another stream when the test
 * targets instruction bounds). */
const rebuildGlyf = (
	payload: Uint8Array,
	mutate: (s: GlyfStreams) => void,
	padStream: (typeof GLYF_STREAM_ORDER)[number] = "ins",
): Uint8Array => {
	const s = splitGlyfStreams(payload);
	const before = GLYF_STREAM_ORDER.reduce((n, k) => n + s[k].length, 0);
	mutate(s);
	const after = GLYF_STREAM_ORDER.reduce((n, k) => n + s[k].length, 0);
	const deficit = before - after;
	if (deficit < 0) throw new Error("mutation grew the payload");
	for (let i = 0; i < deficit; i++) s[padStream].push(0);
	const header = [...payload.subarray(0, 36)];
	GLYF_STREAM_ORDER.forEach((name, i) => {
		header[8 + i * 4] = (s[name].length >>> 24) & 0xff;
		header[8 + i * 4 + 1] = (s[name].length >>> 16) & 0xff;
		header[8 + i * 4 + 2] = (s[name].length >>> 8) & 0xff;
		header[8 + i * 4 + 3] = s[name].length & 0xff;
	});
	return new Uint8Array([
		...header,
		...GLYF_STREAM_ORDER.flatMap((k) => s[k]),
		...s.overlap,
		...s.trailing,
	]);
};

describe("woff2ToSfnt — directory edge cases", () => {
	it("rejects a directory that runs into the compressed region", async () => {
		// numTables=2 but only one entry fits before EOF (compressedSize=0).
		const f = new Uint8Array(50);
		f.set([0x77, 0x4f, 0x46, 0x32], 0);
		const v = new DataView(f.buffer);
		v.setUint16(12, 2);
		f[48] = 0; // cmap known-tag flags
		f[49] = 0; // origLength = 0
		expect(await woff2ToSfnt(f)).toBeNull();
	});

	it("rejects a truncated custom tag and a missing transformLength", async () => {
		// Custom tag (0x3f) with only 2 of 4 tag bytes present.
		const custom = new Uint8Array(51);
		custom.set([0x77, 0x4f, 0x46, 0x32], 0);
		const cv = new DataView(custom.buffer);
		cv.setUint16(12, 1);
		custom[48] = 0x3f;
		custom[49] = 0x41;
		custom[50] = 0x42;
		expect(await woff2ToSfnt(custom)).toBeNull();
		// Transformed hmtx whose transformLength base128 is cut off.
		const tl = new Uint8Array(50);
		tl.set([0x77, 0x4f, 0x46, 0x32], 0);
		const tv = new DataView(tl.buffer);
		tv.setUint16(12, 1);
		tl[48] = (1 << 6) | 3; // hmtx, transform version 1
		tl[49] = 5; // origLength
		expect(await woff2ToSfnt(tl)).toBeNull();
	});

	it("assembles an sfnt without head (no checksum adjustment)", async () => {
		const sfnt = await woff2ToSfnt(woff2([{ name: "cmap", stored: [1, 2] }]));
		expect(sfnt).not.toBeNull();
		expect(sfntTables(sfnt!).map((t) => t.tag)).toEqual(["cmap"]);
	});
});

describe("woff2ToSfnt — nPoints/flags/glyph stream corruption", () => {
	const wrap = (payload: Uint8Array) =>
		woff2([
			{ name: "glyf", stored: [...payload], origLength: 100 },
			{ name: "loca", stored: [], origLength: 8 },
			...MINIMAL_TABLES,
		]);
	const onePointGlyph = () =>
		buildGlyfTransform([
			{
				kind: "simple",
				contours: [{ points: [{ dx: 1, dy: 1 }] }],
			},
		]).payload;

	it("rejects truncated 255UInt16 reads in nPointsStream", async () => {
		for (const np of [[], [253], [254], [255]]) {
			const p = rebuildGlyf(onePointGlyph(), (s) => {
				s.np = np;
			});
			expect(await woff2ToSfnt(wrap(p))).toBeNull();
		}
	});

	it("rejects flagStream and glyphStream truncations", async () => {
		const twoPoints = buildGlyfTransform([
			{
				kind: "simple",
				contours: [
					{
						points: [
							{ dx: 1, dy: 1 },
							{ dx: 2, dy: 2 },
						],
					},
				],
			},
		]).payload;
		// nPoints=2 but only 1 flag byte.
		const fl = rebuildGlyf(twoPoints, (s) => {
			s.fl = s.fl.slice(0, 1);
		});
		expect(await woff2ToSfnt(wrap(fl))).toBeNull();
		// 1 point needs a 4-byte triplet; give glyphStream 2 bytes.
		const gl = rebuildGlyf(onePointGlyph(), (s) => {
			s.gl = s.gl.slice(0, 2);
		});
		expect(await woff2ToSfnt(wrap(gl))).toBeNull();
	});

	it("rejects missing instruction length and overflowing instruction data", async () => {
		// glyphStream ends right after the triplet — no instrLen byte.
		const noLen = rebuildGlyf(onePointGlyph(), (s) => {
			s.gl = s.gl.slice(0, 4);
		});
		expect(await woff2ToSfnt(wrap(noLen))).toBeNull();
		// instrLen=2 but instructionStream is empty.
		const overIns = rebuildGlyf(
			onePointGlyph(),
			(s) => {
				s.gl = [...s.gl.slice(0, 4), 2]; // instrLen prefix = 2
				s.ins = [];
			},
			"np",
		);
		expect(await woff2ToSfnt(wrap(overIns))).toBeNull();
	});

	it("rejects truncated stored bboxes for simple and composite glyphs", async () => {
		// Simple glyph with stored bbox but no 8-byte record.
		const simple = buildGlyfTransform([
			{
				kind: "simple",
				contours: [{ points: [{ dx: 1, dy: 1 }] }],
				bbox: [0, 0, 5, 5],
			},
		]).payload;
		const bbSimple = rebuildGlyf(simple, (s) => {
			s.bb = [0x80, 0, 0, 0]; // bitmap bit set, zero record bytes
		});
		expect(await woff2ToSfnt(wrap(bbSimple))).toBeNull();
		// Composite glyph likewise.
		const comp = buildGlyfTransform([
			{
				kind: "composite",
				components: [{ glyphId: 0, argsAreXY: true, a1: 0, a2: 0 }],
				bbox: [0, 0, 1, 1],
			},
		]).payload;
		const bbComp = rebuildGlyf(comp, (s) => {
			s.bb = [0x80, 0, 0, 0];
		});
		expect(await woff2ToSfnt(wrap(bbComp))).toBeNull();
	});

	it("rejects truncated nContourStream and bad contour counts", async () => {
		// 2 glyphs but nContourStream holds only one int16.
		const two = buildGlyfTransform([{ kind: "empty" }, { kind: "empty" }]).payload;
		const nc = rebuildGlyf(two, (s) => {
			s.nc = s.nc.slice(0, 2);
		});
		expect(await woff2ToSfnt(wrap(nc))).toBeNull();
		// numberOfContours = -2.
		const neg = rebuildGlyf(onePointGlyph(), (s) => {
			s.nc = [0xff, 0xfe];
		});
		expect(await woff2ToSfnt(wrap(neg))).toBeNull();
	});
});

describe("woff2ToSfnt — composite stream corruption", () => {
	const wrap = (payload: Uint8Array) =>
		woff2([
			{ name: "glyf", stored: [...payload], origLength: 100 },
			{ name: "loca", stored: [], origLength: 8 },
			...MINIMAL_TABLES,
		]);
	const compGlyph = (transform?: ComponentSpec["transform"], words = false) =>
		buildGlyfTransform([
			{
				kind: "composite",
				components: [
					{
						glyphId: 0,
						argsAreXY: true,
						a1: words ? 300 : 1,
						a2: words ? 400 : 2,
						argWords: words,
						transform,
					},
				],
				instructions: [0x11],
				bbox: [0, 0, 1, 1],
			},
		]).payload;

	it("rejects truncated component records at every field", async () => {
		// Empty compositeStream → flags read fails.
		const empty = rebuildGlyf(compGlyph(), (s) => {
			s.cp = [];
		});
		expect(await woff2ToSfnt(wrap(empty))).toBeNull();
		// Word args: flags+glyphID present, 4 arg bytes missing.
		const w = rebuildGlyf(compGlyph(undefined, true), (s) => {
			s.cp = s.cp.slice(0, 4);
		});
		expect(await woff2ToSfnt(wrap(w))).toBeNull();
		// Byte args: 2 arg bytes missing.
		const b = rebuildGlyf(compGlyph(), (s) => {
			s.cp = s.cp.slice(0, 4);
		});
		expect(await woff2ToSfnt(wrap(b))).toBeNull();
	});

	it("rejects truncated transform payloads", async () => {
		for (const [transform, keep] of [
			[{ kind: "scale", s: 16384 } as const, 6], // flags+gid+2B args
			[{ kind: "xyscale", x: 8192, y: 16384 } as const, 6],
			[{ kind: "2x2", v: [16384, 0, 8192, 16384] as const } as const, 6],
		] as const) {
			const p = rebuildGlyf(compGlyph(transform), (s) => {
				s.cp = s.cp.slice(0, keep);
			});
			expect(await woff2ToSfnt(wrap(p))).toBeNull();
		}
	});

	it("rejects composite instructions that cannot be read", async () => {
		// HAVE_INSTRUCTIONS set but glyphStream has no instrLen byte.
		const p = rebuildGlyf(compGlyph(), (s) => {
			s.gl = [];
		});
		expect(await woff2ToSfnt(wrap(p))).toBeNull();
	});
});

describe("woff2ToSfnt — hmtx/raw-glyf remaining branches", () => {
	it("rejects a truncated trailing sidebearing array", async () => {
		// 2 glyphs, nHM=1, flags=1 → advances[1] + trailing lsb[1];
		// drop the trailing i16.
		const glyphs: GlyphSpec[] = [{ kind: "empty" }, { kind: "empty" }];
		const { payload } = buildGlyfTransform(glyphs);
		const sfnt = await woff2ToSfnt(
			woff2([
				{ name: "glyf", stored: [...payload], origLength: 60 },
				{ name: "hhea", stored: hheaTable(1), origLength: 36 },
				{ name: "hmtx", stored: [1, ...u16(400)], origLength: 3, transformVersion: 1 },
				{ name: "loca", stored: [], origLength: 12 },
				{ name: "head", stored: headTable(), origLength: 54 },
				{ name: "cmap", stored: [0], origLength: 1 },
			]),
		);
		expect(sfnt).toBeNull();
	});

	it("covers raw-glyf presence variants for transformed hmtx", async () => {
		const hmtxT = {
			name: "hmtx",
			stored: [1, ...u16(400)],
			origLength: 3,
			transformVersion: 1,
		} as const;
		const head = { name: "head", stored: headTable(0), origLength: 54 } as const;
		const hhea = { name: "hhea", stored: hheaTable(1), origLength: 36 } as const;
		const cmap = { name: "cmap", stored: [0], origLength: 1 } as const;
		const glyfRaw = {
			name: "glyf",
			stored: [0, 1, ...i16(0), ...i16(0), ...i16(0), ...i16(0)],
			transformVersion: 3,
			origLength: 10,
		} as const;
		const locaRaw = {
			name: "loca",
			stored: [...u16(0), ...u16(5)],
			transformVersion: 3,
			origLength: 4,
		} as const;
		// glyf present, loca absent → locaRaw null.
		expect(await woff2ToSfnt(woff2([glyfRaw, hmtxT, head, hhea, cmap]))).toBeNull();
		// loca present, glyf absent → glyfRaw null.
		expect(await woff2ToSfnt(woff2([locaRaw, hmtxT, head, hhea, cmap]))).toBeNull();
		// head too short for indexToLocFormat.
		expect(
			await woff2ToSfnt(
				woff2([
					glyfRaw,
					locaRaw,
					hmtxT,
					hhea,
					cmap,
					{ name: "head", stored: headTable(0, 40), origLength: 40 },
				]),
			),
		).toBeNull();
	});
});
