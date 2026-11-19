import { brotliCompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { parseFontVariations } from "./font-variations.ts";

/**
 * Minimal sfnt fixtures — same builders as font-metrics.test.ts plus
 * `fvar` (variation axes) and `cmap` (format 4 + format 12) tables.
 */

const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const i16 = (v: number) => u16(v & 0xffff);
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const i32 = (v: number) => u32(v | 0);
const tag = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const table = (name: string, data: number[]) => ({ name: tag(name), data });

const buildSfnt = (signature: string, tables: { name: number[]; data: number[] }[]): Uint8Array => {
	const numTables = tables.length;
	const headerBytes = 12 + numTables * 16;
	let offset = headerBytes;
	const records: number[] = [];
	const body: number[] = [];
	for (const t of tables) {
		records.push(...t.name, ...u32(0), ...u32(offset), ...u32(t.data.length));
		body.push(...t.data);
		offset += t.data.length;
	}
	return new Uint8Array([
		...tag(signature),
		...u16(numTables),
		...u16(0),
		...u16(0),
		...u16(0),
		...records,
		...body,
	]);
};

/** WOFF wrapper: 44-byte header + 20-byte records; tables stored raw. */
const woff = (tables: { name: number[]; data: number[] }[]): Uint8Array => {
	const numTables = tables.length;
	let offset = 44 + numTables * 20;
	const records: number[] = [];
	const body: number[] = [];
	for (const t of tables) {
		records.push(
			...t.name,
			...u32(offset),
			...u32(t.data.length),
			...u32(t.data.length),
			...u32(0),
		);
		body.push(...t.data);
		offset += t.data.length;
	}
	const total = offset;
	return new Uint8Array([
		...tag("wOFF"),
		...u32(0x00010000),
		...u32(total),
		...u16(numTables),
		...u16(0),
		...u32(0),
		...u16(1),
		...u16(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...records,
		...body,
	]);
};

const base128 = (v: number): number[] => {
	const digits: number[] = [];
	let n = v;
	do {
		digits.unshift(n % 128);
		n = Math.floor(n / 128);
	} while (n > 0);
	return digits.map((d, i) => (i < digits.length - 1 ? d | 0x80 : d));
};

/** WOFF2 fixture: directory entries sorted by tag, bodies brotli'd. */
const woff2 = (tables: { name: string; stored: number[] }[]): Uint8Array => {
	const sorted = [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const dir: number[] = [];
	const body: number[] = [];
	for (const t of sorted) {
		dir.push(0x3f, ...tag(t.name)); // custom tag path
		dir.push(...base128(t.stored.length));
		body.push(...t.stored);
	}
	const compressed = [...brotliCompressSync(new Uint8Array(body))];
	const total = 48 + dir.length + compressed.length;
	return new Uint8Array([
		...tag("wOF2"),
		...u32(0x00010000),
		...u32(total),
		...u16(sorted.length),
		...u16(0),
		...u32(body.length),
		...u32(compressed.length),
		...u16(1),
		...u16(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...u32(0),
		...dir,
		...compressed,
	]);
};

const fixed = (n: number) => i32(Math.round(n * 65536));

interface AxisSpec {
	readonly tag: string;
	readonly min: number;
	readonly def: number;
	readonly max: number;
}

/** fvar table: 16-byte header + 20-byte axis records. */
const fvarTable = (axes: AxisSpec[]): number[] => {
	const out = [
		...u16(1), // majorVersion
		...u16(0), // minorVersion
		...u16(16), // axesArrayOffset
		...u16(0), // reserved
		...u16(axes.length), // axisCount
		...u16(20), // axisSize
		...u16(0), // instanceCount
		...u16(0), // instanceSize
	];
	for (const a of axes) {
		out.push(
			...tag(a.tag),
			...fixed(a.min),
			...fixed(a.def),
			...fixed(a.max),
			...u16(0), // flags
			...u16(256), // nameID
		);
	}
	return out;
};

/** cmap format 12 (full UCS-4) wrapped in a one-record cmap table. */
const cmap12 = (groups: readonly (readonly [number, number])[]): number[] => {
	const sub = [
		...u16(12),
		...u16(0),
		...u32(16 + groups.length * 12),
		...u32(0), // language
		...u32(groups.length),
	];
	for (const [start, end] of groups) {
		sub.push(...u32(start), ...u32(end), ...u32(0));
	}
	return [...u16(0), ...u16(1), ...u16(3), ...u16(10), ...u32(12), ...sub];
};

/** cmap format 4 (BMP segments) wrapped in a one-record cmap table. */
const cmap4 = (segments: readonly (readonly [number, number])[]): number[] => {
	const segCount = segments.length;
	const sub = [
		...u16(4),
		...u16(16 + segCount * 8), // length
		...u16(0), // language
		...u16(segCount * 2), // segCountX2
		...u16(0), // searchRange
		...u16(0), // entrySelector
		...u16(0), // rangeShift
	];
	for (const [, end] of segments) sub.push(...u16(end));
	sub.push(...u16(0)); // reservedPad
	for (const [start] of segments) sub.push(...u16(start));
	for (let i = 0; i < segCount; i++) sub.push(...i16(0)); // idDelta
	for (let i = 0; i < segCount; i++) sub.push(...u16(0)); // idRangeOffset
	return [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub];
};

const ttf = (...tables: { name: number[]; data: number[] }[]) => buildSfnt("true", tables);

describe("parseFontVariations — fvar", () => {
	it("reads the wght axis from a TTF", async () => {
		const font = ttf(
			table("fvar", fvarTable([{ tag: "wght", min: 100, def: 400, max: 900 }])),
			table("cmap", cmap12([[0x20, 0x7e]])),
		);
		const info = await parseFontVariations(font);
		expect(info?.variable).toBe(true);
		expect(info?.weightAxis).toEqual({ min: 100, default: 400, max: 900 });
		expect(info?.unicodeRange).toBe("U+0020-007E");
	});

	it("handles fractional Fixed values and multiple axes", async () => {
		const font = ttf(
			table(
				"fvar",
				fvarTable([
					{ tag: "wght", min: 62.5, def: 400, max: 900 },
					{ tag: "wdth", min: 50, def: 100, max: 200 },
				]),
			),
		);
		const info = await parseFontVariations(font, "ttf");
		expect(info?.variable).toBe(true);
		expect(info?.weightAxis).toEqual({ min: 62.5, default: 400, max: 900 });
		expect(info?.unicodeRange).toBeUndefined();
	});

	it("marks fonts with fvar but no wght axis variable, reporting other axes", async () => {
		const font = ttf(table("fvar", fvarTable([{ tag: "wdth", min: 50, def: 100, max: 200 }])));
		const info = await parseFontVariations(font);
		expect(info).toEqual({
			variable: true,
			axes: [{ tag: "wdth", min: 50, default: 100, max: 200 }],
		});
	});

	it("collects every non-wght axis in table order, wght excluded", async () => {
		const font = ttf(
			table(
				"fvar",
				fvarTable([
					{ tag: "wght", min: 100, def: 400, max: 900 },
					{ tag: "wdth", min: 75, def: 100, max: 125 },
					{ tag: "opsz", min: 6, def: 14, max: 72 },
					{ tag: "slnt", min: -12, def: 0, max: 0 },
					{ tag: "ital", min: 0, def: 0, max: 1 },
					{ tag: "XOPQ", min: 100, def: 400, max: 900 },
				]),
			),
		);
		const info = await parseFontVariations(font);
		expect(info?.weightAxis).toEqual({ min: 100, default: 400, max: 900 });
		expect(info?.axes).toEqual([
			{ tag: "wdth", min: 75, default: 100, max: 125 },
			{ tag: "opsz", min: 6, default: 14, max: 72 },
			{ tag: "slnt", min: -12, default: 0, max: 0 },
			{ tag: "ital", min: 0, default: 0, max: 1 },
			{ tag: "XOPQ", min: 100, default: 400, max: 900 },
		]);
	});

	it("keeps fractional axis values unclamped and drops malformed/duplicate axes", async () => {
		const font = ttf(
			table(
				"fvar",
				fvarTable([
					// Inverted bounds → dropped.
					{ tag: "XXXX", min: 100, def: 50, max: 900 },
					// First record per tag wins.
					{ tag: "wdth", min: 50, def: 100, max: 200 },
					{ tag: "wdth", min: 60, def: 100, max: 210 },
					// Negative/huge values are NOT clamped (only wght is);
					// 30000 stays inside the Fixed 16.16 int32 range.
					{ tag: "opsz", min: -5, def: 0.5, max: 30000 },
				]),
			),
		);
		const info = await parseFontVariations(font);
		expect(info?.axes).toEqual([
			{ tag: "wdth", min: 50, default: 100, max: 200 },
			{ tag: "opsz", min: -5, default: 0.5, max: 30000 },
		]);
	});

	it("caps reported axes at 32 records", async () => {
		const axes: AxisSpec[] = [];
		for (let i = 0; i < 40; i++) {
			// Distinct 4-char tags: 'AX' + two hex digits.
			axes.push({
				tag: `A${i.toString(16).padStart(3, "0")}`,
				min: 0,
				def: 1,
				max: 2,
			});
		}
		const info = await parseFontVariations(ttf(table("fvar", fvarTable(axes))));
		expect(info?.axes).toHaveLength(32);
		expect(info?.axes?.[0]?.tag).toBe("A000");
		expect(info?.axes?.[31]?.tag).toBe("A01f");
	});

	it("rejects a wght axis with inverted bounds", async () => {
		// def < min violates min <= default <= max → axis dropped.
		const font = ttf(table("fvar", fvarTable([{ tag: "wght", min: 500, def: 100, max: 900 }])));
		const info = await parseFontVariations(font);
		expect(info?.variable).toBe(true);
		expect(info?.weightAxis).toBeUndefined();
	});

	it("clamps the wght axis to the CSS font-weight domain (1–1000)", async () => {
		const font = ttf(table("fvar", fvarTable([{ tag: "wght", min: -50, def: 400, max: 1500 }])));
		const info = await parseFontVariations(font);
		expect(info?.weightAxis).toEqual({ min: 1, default: 400, max: 1000 });
	});

	it("treats truncated/malformed fvar tables as variable without axes", async () => {
		// fvar shorter than its 16-byte header.
		const tiny = ttf(table("fvar", [1, 0, 0]));
		expect((await parseFontVariations(tiny))?.variable).toBe(true);
		// axisSize too small to hold a 20-byte record.
		const small = [
			...u16(1),
			...u16(0),
			...u16(16),
			...u16(0),
			...u16(1),
			...u16(4), // axisSize
			...u16(0),
			...u16(0),
		];
		expect((await parseFontVariations(ttf(table("fvar", small))))?.weightAxis).toBeUndefined();
		// axisCount claims more records than the table holds.
		const overflow = [...fvarTable([])];
		overflow[8] = 0;
		overflow[9] = 9; // axisCount = 9 with zero records
		const info = await parseFontVariations(ttf(table("fvar", overflow)));
		expect(info?.variable).toBe(true);
		expect(info?.weightAxis).toBeUndefined();
	});

	it("reads fvar and cmap from WOFF containers", async () => {
		const font = woff([
			table("fvar", fvarTable([{ tag: "wght", min: 100, def: 400, max: 900 }])),
			table("cmap", cmap12([[0x41, 0x5a]])),
		]);
		const info = await parseFontVariations(font);
		expect(info?.weightAxis).toEqual({ min: 100, default: 400, max: 900 });
		expect(info?.unicodeRange).toBe("U+0041-005A");
	});

	it("reads fvar and cmap from WOFF2 containers", async () => {
		const font = woff2([
			{ name: "fvar", stored: fvarTable([{ tag: "wght", min: 300, def: 400, max: 700 }]) },
			{ name: "cmap", stored: cmap12([[0x30, 0x39]]) },
		]);
		const info = await parseFontVariations(font);
		expect(info?.weightAxis).toEqual({ min: 300, default: 400, max: 700 });
		expect(info?.unicodeRange).toBe("U+0030-0039");
	});

	it("returns null for unrecognized and truncated input", async () => {
		expect(await parseFontVariations(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(await parseFontVariations(ttf().slice(0, 8))).toBeNull();
		// Unknown sfnt signature without a format hint.
		expect(await parseFontVariations(buildSfnt("abcd", []))).toBeNull();
		// …but the format hint admits it.
		expect(await parseFontVariations(buildSfnt("abcd", []), "ttf")).toEqual({ variable: false });
		// OTTO signature.
		expect((await parseFontVariations(buildSfnt("OTTO", [])))?.variable).toBe(false);
		// "woff"/"woff2" format hints admit containers whose signature is
		// nonstandard — but tableBytes still rejects unknown head4s.
		const alien = buildSfnt("XXXX", []);
		expect(await parseFontVariations(alien, "woff")).toEqual({ variable: false });
		expect(await parseFontVariations(alien, "woff2")).toEqual({ variable: false });
	});

	it("survives forged views whose directory reads overflow the buffer", async () => {
		// Same trick as font-metrics.test.ts: byteLength/byteOffset pass
		// the early checks but the real buffer is smaller — the inner
		// DataView construction throws and is caught per-table.
		const buffer = new ArrayBuffer(60);
		const forged = {
			byteLength: 100,
			byteOffset: 50,
			buffer,
		} as unknown as Uint8Array;
		expect(await parseFontVariations(forged, "ttf")).toEqual({ variable: false });
	});
});

describe("parseFontVariations — cmap", () => {
	it("merges overlapping and adjacent format-12 groups", async () => {
		const font = ttf(
			table(
				"cmap",
				cmap12([
					[0x20, 0x7e],
					[0x7f, 0xff],
					[0x100, 0x17f],
					[0x400, 0x4ff],
				]),
			),
		);
		const info = await parseFontVariations(font);
		// Adjacent ranges collapse: 0x20-0x7e + 0x7f-0xff + 0x100-0x17f.
		expect(info?.unicodeRange).toBe("U+0020-017F, U+0400-04FF");
	});

	it("reads format-4 BMP segments and skips the sentinel", async () => {
		const font = ttf(
			table(
				"cmap",
				cmap4([
					[0x20, 0x7e],
					[0x100, 0x17f],
					[0xffff, 0xffff],
				]),
			),
		);
		const info = await parseFontVariations(font);
		expect(info?.unicodeRange).toBe("U+0020-007E, U+0100-017F");
	});

	it("prefers format 12 over format 4 when both exist", async () => {
		// Directory: format-4 record first, format-12 second; the
		// subtables follow in the same order.
		const sub4 = cmap4([[0x41, 0x41]]).slice(12);
		const sub12 = cmap12([[0x1f600, 0x1f64f]]).slice(12);
		const dirLen = 4 + 16;
		const cmapTable = [
			...u16(0),
			...u16(2),
			...u16(3),
			...u16(1),
			...u32(dirLen),
			...u16(3),
			...u16(10),
			...u32(dirLen + sub4.length),
			...sub4,
			...sub12,
		];
		const info = await parseFontVariations(ttf(table("cmap", cmapTable)));
		expect(info?.unicodeRange).toBe("U+1F600-1F64F");
	});

	it("returns no unicodeRange for missing, empty or fragmented cmaps", async () => {
		// No cmap at all.
		expect((await parseFontVariations(ttf()))?.unicodeRange).toBeUndefined();
		// Empty cmap (no subtables).
		expect(
			(await parseFontVariations(ttf(table("cmap", [...u16(0), ...u16(0)]))))?.unicodeRange,
		).toBeUndefined();
		// Subtable offset pointing outside the table.
		const bad = [...u16(0), ...u16(1), ...u16(3), ...u16(10), ...u32(0xffff)];
		expect((await parseFontVariations(ttf(table("cmap", bad))))?.unicodeRange).toBeUndefined();
		// Format 4 with zero segments.
		const empty4 = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...cmap4Body(0)];
		expect((await parseFontVariations(ttf(table("cmap", empty4))))?.unicodeRange).toBeUndefined();
	});

	it("drops unicodeRange when coverage is too fragmented", async () => {
		// 200 disjoint astral groups → merged count > 128 → no hint.
		const groups: [number, number][] = [];
		for (let i = 0; i < 200; i++) groups.push([0x10000 + i * 8, 0x10000 + i * 8 + 1]);
		const info = await parseFontVariations(ttf(table("cmap", cmap12(groups))));
		expect(info?.unicodeRange).toBeUndefined();
	});

	it("drops unicodeRange when the descriptor would exceed the byte cap", async () => {
		// 128 disjoint astral ranges near U+100000: each serializes to
		// "U+100000-1000FF" (15 chars) + ", " → 128 × 17 > 2048.
		const groups: [number, number][] = [];
		for (let i = 0; i < 128; i++) {
			const start = 0x100000 + i * 0x40;
			groups.push([start, start + 0x10]);
		}
		const info = await parseFontVariations(ttf(table("cmap", cmap12(groups))));
		expect(info?.unicodeRange).toBeUndefined();
	});

	it("emits single-codepoint ranges without a dash", async () => {
		const info = await parseFontVariations(
			ttf(
				table(
					"cmap",
					cmap12([
						[0x41, 0x41],
						[0x50, 0x50],
					]),
				),
			),
		);
		expect(info?.unicodeRange).toBe("U+0041, U+0050");
	});

	it("tolerates truncated and empty cmap subtables", async () => {
		// cmap shorter than its 4-byte header.
		expect((await parseFontVariations(ttf(table("cmap", [0, 0]))))?.unicodeRange).toBeUndefined();
		// numTables claims more records than the table holds.
		const overflow = [...u16(0), ...u16(5), ...new Array(8).fill(0)];
		expect((await parseFontVariations(ttf(table("cmap", overflow))))?.unicodeRange).toBeUndefined();
		// Format-12 record whose subtable is shorter than its 16-byte header.
		const short12 = [
			...u16(0),
			...u16(1),
			...u16(3),
			...u16(10),
			...u32(12),
			...u16(12),
			...u16(0),
		];
		expect((await parseFontVariations(ttf(table("cmap", short12))))?.unicodeRange).toBeUndefined();
		// Format-12 numGroups overflows the table.
		const badGroups = [
			...u16(0),
			...u16(1),
			...u16(3),
			...u16(10),
			...u32(12),
			...u16(12),
			...u16(0),
			...u32(16),
			...u32(0),
			...u32(0xffffffff),
		];
		expect(
			(await parseFontVariations(ttf(table("cmap", badGroups))))?.unicodeRange,
		).toBeUndefined();
		// Format-4 subtable shorter than its 14-byte header.
		const short4 = [
			...u16(0),
			...u16(1),
			...u16(3),
			...u16(1),
			...u32(12),
			...new Array(10).fill(0),
		];
		short4[12] = 0;
		short4[13] = 4; // format = 4 at the subtable offset
		expect((await parseFontVariations(ttf(table("cmap", short4))))?.unicodeRange).toBeUndefined();
		// Format-4 arrays truncated mid-table.
		const truncated4 = [
			...u16(0),
			...u16(1),
			...u16(3),
			...u16(1),
			...u32(12),
			...u16(4),
			...u16(24), // length
			...u16(0), // language
			...u16(4), // segCountX2 → 2 segments
			...u16(0),
			...u16(0),
			...u16(0),
			// endCode[2] then file ends — startCode array missing.
			...u16(0x7e),
			...u16(0xffff),
		];
		expect(
			(await parseFontVariations(ttf(table("cmap", truncated4))))?.unicodeRange,
		).toBeUndefined();
		// Inverted groups/segments are skipped; empty coverage → no hint.
		const inverted12 = await parseFontVariations(ttf(table("cmap", cmap12([[0x100, 0x50]]))));
		expect(inverted12?.unicodeRange).toBeUndefined();
		const inverted4 = await parseFontVariations(ttf(table("cmap", cmap4([[0x60, 0x40]]))));
		expect(inverted4?.unicodeRange).toBeUndefined();
		// Zero-group format 12 → empty ranges → no hint.
		expect(
			(await parseFontVariations(ttf(table("cmap", cmap12([])))))?.unicodeRange,
		).toBeUndefined();
	});

	it("uses the first format-4 subtable when several exist", async () => {
		// Two format-4 records: the parser keeps the first.
		const sub4a = cmap4([[0x41, 0x41]]).slice(12);
		const sub4b = cmap4([[0x50, 0x50]]).slice(12);
		const dirLen = 4 + 16;
		const cmapTable = [
			...u16(0),
			...u16(2),
			...u16(3),
			...u16(1),
			...u32(dirLen),
			...u16(3),
			...u16(1),
			...u32(dirLen + sub4b.length),
			...sub4a,
			...sub4b,
		];
		const info = await parseFontVariations(ttf(table("cmap", cmapTable)));
		expect(info?.unicodeRange).toBe("U+0041");
	});

	it("ignores sfnt table records pointing outside the file", async () => {
		// Corrupt the fvar record's length so the bounds check rejects
		// it; the cmap record stays valid and still yields a hint.
		const font = ttf(
			table("fvar", fvarTable([{ tag: "wght", min: 100, def: 400, max: 900 }])),
			table("cmap", cmap12([[0x20, 0x7e]])),
		);
		const corrupt = font.slice();
		// First table record starts at byte 12; length field is +12.
		new DataView(corrupt.buffer).setUint32(12 + 12, 0xfffffff0);
		const info = await parseFontVariations(corrupt);
		expect(info?.variable).toBe(false);
		expect(info?.unicodeRange).toBe("U+0020-007E");
	});

	it("handles WOFF2 fonts missing one of the probed tables", async () => {
		// cmap present, fvar absent → static font with a unicode hint.
		const staticWoff2 = woff2([{ name: "cmap", stored: cmap12([[0x30, 0x39]]) }]);
		const info = await parseFontVariations(staticWoff2);
		expect(info).toEqual({ variable: false, unicodeRange: "U+0030-0039" });
	});

	it("returns a bare result for WOFF2 containers that fail to decode", async () => {
		const font = woff2([
			{ name: "fvar", stored: fvarTable([{ tag: "wght", min: 100, def: 400, max: 900 }]) },
		]);
		const corrupt = font.slice();
		corrupt.fill(0xff, corrupt.length - 8);
		expect(await parseFontVariations(corrupt)).toEqual({ variable: false });
	});
});

/** Bare format-4 subtable body (no cmap wrapper) for edge fixtures. */
const cmap4Body = (segCount: number): number[] => [
	...u16(4),
	...u16(16 + segCount * 8),
	...u16(0),
	...u16(segCount * 2),
	...u16(0),
	...u16(0),
	...u16(0),
	...new Array(segCount * 2).fill(0),
	...u16(0),
	...new Array(segCount * 2).fill(0),
	...new Array(segCount * 2).fill(0),
	...new Array(segCount * 2).fill(0),
];
