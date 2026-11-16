import { brotliCompressSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
	FALLBACK_FONT_METRICS,
	computeMetricOverrides,
	localFontForSlot,
	parseFontMetrics,
	type FontMetrics,
} from "./font-metrics.ts";

/**
 * Minimal sfnt fixtures: a TTF directory carrying head/hhea/OS/2 tables
 * with the exact field offsets the parser reads (head.unitsPerEm @+18,
 * hhea ascent/descent/lineGap @+4/6/8, OS/2 xAvgCharWidth @+2).
 */

const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const i16 = (v: number) => u16(v & 0xffff);
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const tag = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const table = (name: string, data: number[]) => ({ name: tag(name), data });

const headTable = (unitsPerEm: number) => {
	const d = new Array(20).fill(0);
	d.splice(18, 2, ...u16(unitsPerEm));
	return table("head", d);
};

const hheaTable = (ascent: number, descent: number, lineGap: number) => {
	const d = new Array(10).fill(0);
	d.splice(4, 2, ...i16(ascent));
	d.splice(6, 2, ...i16(descent));
	d.splice(8, 2, ...i16(lineGap));
	return table("hhea", d);
};

const os2Table = (xAvgCharWidth: number) => {
	const d = new Array(4).fill(0);
	d.splice(2, 2, ...i16(xAvgCharWidth));
	return table("OS/2", d);
};

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
	const out = [
		...tag(signature),
		...u16(numTables),
		...u16(0),
		...u16(0),
		...u16(0),
		...records,
		...body,
	];
	return new Uint8Array(out);
};

const ttf = (unitsPerEm = 2048, ascent = 1800, descent = -400, lineGap = 0, avg = 900) =>
	buildSfnt("true", [headTable(unitsPerEm), hheaTable(ascent, descent, lineGap), os2Table(avg)]);

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
			...u32(t.data.length), // compLength == origLength → stored raw
			...u32(t.data.length),
			...u32(0),
		);
		body.push(...t.data);
		offset += t.data.length;
	}
	const total = offset;
	return new Uint8Array([
		...tag("wOFF"),
		...u32(0x00010000), // flavor: TrueType
		...u32(total),
		...u16(numTables),
		...u16(0), // reserved
		...u32(0), // totalSfntSize (unused by the parser)
		...u16(1), // majorVersion
		...u16(0), // minorVersion
		...u32(0), // metaOffset
		...u32(0), // metaLength
		...u32(0), // metaOrigLength
		...u32(0), // privOffset
		...u32(0), // privLength
		...records,
		...body,
	]);
};

/**
 * WOFF2 fixture builder. Directory entries are sorted by tag (spec
 * requirement); `stored` bytes are concatenated into the single Brotli
 * stream. `transformVersion` sets flags bits 6-7 — non-zero marks the
 * table transformed (except glyf/loca, where version 3 is the null
 * transform), in which case a second UIntBase128 transformLength is
 * written and only `stored` bytes land in the decompressed block.
 */
const WOFF2_KNOWN_TAG_INDEX: Record<string, number> = {
	head: 1,
	hhea: 2,
	hmtx: 3,
	"OS/2": 6,
	glyf: 10,
	loca: 11,
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

interface Woff2Spec {
	readonly name: string;
	readonly stored: number[];
	readonly origLength?: number;
	readonly transformVersion?: number;
}

const woff2Transformed = (name: string, version: number) =>
	name === "glyf" || name === "loca" ? version !== 3 : version !== 0;

const woff2 = (tables: Woff2Spec[]): Uint8Array => {
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
		body.push(...t.stored);
	}
	const compressed = [...brotliCompressSync(new Uint8Array(body))];
	const total = 48 + dir.length + compressed.length;
	return new Uint8Array([
		...tag("wOF2"),
		...u32(0x00010000), // flavor
		...u32(total), // length
		...u16(sorted.length), // numTables
		...u16(0), // reserved
		...u32(body.length), // totalSfntSize (unused by the parser)
		...u32(compressed.length), // totalCompressedSize
		...u16(1), // majorVersion
		...u16(0), // minorVersion
		...u32(0),
		...u32(0),
		...u32(0), // meta
		...u32(0),
		...u32(0), // priv
		...dir,
		...compressed,
	]);
};

describe("parseFontMetrics", () => {
	it("parses TTF sfnt metrics", async () => {
		const m = await parseFontMetrics(ttf(1000, 800, -200, 50, 500));
		expect(m).toEqual({
			unitsPerEm: 1000,
			ascent: 800,
			descent: -200,
			lineGap: 50,
			xAvgCharWidth: 500,
		});
	});

	it("parses OTTO (CFF OpenType) containers", async () => {
		const m = await parseFontMetrics(
			buildSfnt("OTTO", [headTable(2048), hheaTable(1000, -200, 0)]),
		);
		expect(m?.unitsPerEm).toBe(2048);
		expect(m?.ascent).toBe(1000);
		expect(m?.xAvgCharWidth).toBeUndefined();
	});

	it("parses WOFF containers with raw tables", async () => {
		const m = await parseFontMetrics(
			woff([headTable(2048), hheaTable(1500, -300, 10), os2Table(700)]),
		);
		expect(m).toEqual({
			unitsPerEm: 2048,
			ascent: 1500,
			descent: -300,
			lineGap: 10,
			xAvgCharWidth: 700,
		});
	});

	it("parses WOFF tables compressed with zlib", async () => {
		const head = headTable(2048);
		const hhea = hheaTable(1000, -200, 0);
		// Rebuild the WOFF with deflate-compressed table payloads.
		const deflate = async (bytes: number[]) =>
			new Uint8Array(
				await new Response(
					new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("deflate")),
				).arrayBuffer(),
			);
		const [cHead, cHhea] = await Promise.all([deflate(head.data), deflate(hhea.data)]);
		const tables = [
			{ name: head.name, data: [...cHead] },
			{ name: hhea.name, data: [...cHhea] },
		];
		const numTables = tables.length;
		let offset = 44 + numTables * 20;
		const records: number[] = [];
		const body: number[] = [];
		for (const t of tables) {
			const orig = t.name.join("");
			const origLen = orig === "head" ? 20 : 10;
			records.push(...t.name, ...u32(offset), ...u32(t.data.length), ...u32(origLen), ...u32(0));
			body.push(...t.data);
			offset += t.data.length;
		}
		const w = new Uint8Array([
			...tag("wOFF"),
			...u32(0x00010000),
			...u32(offset),
			...u16(numTables),
			...u16(0), // reserved
			...u32(0), // totalSfntSize
			...u16(1), // majorVersion
			...u16(0), // minorVersion
			...u32(0),
			...u32(0),
			...u32(0),
			...u32(0),
			...u32(0),
			...records,
			...body,
		]);
		const m = await parseFontMetrics(w);
		expect(m?.unitsPerEm).toBe(2048);
		expect(m?.ascent).toBe(1000);
	});

	it("parses WOFF2 metrics, including transformed and custom-tag tables", async () => {
		const m = await parseFontMetrics(
			woff2([
				{ name: "OS/2", stored: os2Table(650).data },
				{ name: "head", stored: headTable(2048).data },
				{ name: "hhea", stored: hheaTable(1500, -300, 10).data },
				// hmtx transform (version 1): origLength differs from the
				// transformLength bytes actually stored.
				{
					name: "hmtx",
					stored: [1, 2, 3, 4],
					origLength: 40,
					transformVersion: 1,
				},
				// glyf with transform version 3 = null transform (stored raw).
				{ name: "glyf", stored: [9, 9, 9], transformVersion: 3 },
				// Unknown tag → flags 0x3F + literal 4-byte tag.
				{ name: "ZZZ ", stored: [0] },
			]),
		);
		expect(m).toEqual({
			unitsPerEm: 2048,
			ascent: 1500,
			descent: -300,
			lineGap: 10,
			xAvgCharWidth: 650,
		});
	});

	it("parses WOFF2 without an OS/2 table", async () => {
		const m = await parseFontMetrics(
			woff2([
				{ name: "head", stored: headTable(1000).data },
				{ name: "hhea", stored: hheaTable(800, -200, 50).data },
			]),
		);
		expect(m).toEqual({
			unitsPerEm: 1000,
			ascent: 800,
			descent: -200,
			lineGap: 50,
			xAvgCharWidth: undefined,
		});
	});

	it("returns null for WOFF2 junk and truncated input", async () => {
		expect(await parseFontMetrics(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(await parseFontMetrics(ttf().slice(0, 8))).toBeNull();
		// "wOF2" signature but shorter than the 48-byte header.
		const short = new Uint8Array([...tag("wOF2"), ...new Array(40).fill(0)]);
		expect(await parseFontMetrics(short)).toBeNull();
	});

	it("returns null for WOFF2 directories that overrun the file", async () => {
		const valid = woff2([{ name: "head", stored: headTable(1000).data }]);
		// numTables claims more entries than the directory holds.
		const truncated = valid.slice(0, 50);
		new DataView(truncated.buffer).setUint16(12, 5);
		expect(await parseFontMetrics(truncated)).toBeNull();
		// Entry flags 0x3F (custom tag) with fewer than 4 tag bytes left.
		const customTrunc = woff2([{ name: "head", stored: headTable(1000).data }]).slice(0, 51);
		customTrunc[48] = 0x3f;
		expect(await parseFontMetrics(customTrunc)).toBeNull();
	});

	it("returns null for WOFF2 base128 fields that are invalid", async () => {
		const base = woff2([{ name: "head", stored: headTable(1000).data }]);
		// origLength starting with 0x80 (leading zeros are banned).
		const leadingZero = base.slice();
		leadingZero[49] = 0x80;
		expect(await parseFontMetrics(leadingZero)).toBeNull();
		// origLength continuation bit still set after 5 bytes.
		const tooLong = base.slice();
		tooLong.set([0x81, 0x82, 0x83, 0x84, 0x85, 0x06], 49);
		expect(await parseFontMetrics(tooLong)).toBeNull();
		// UIntBase128 value exceeding u32 — five 0x7f digits overflow.
		const overflow = base.slice();
		overflow.set([0xff, 0xff, 0xff, 0xff, 0x7f], 49);
		expect(await parseFontMetrics(overflow)).toBeNull();
		// Truncated right after the flags byte (no base128 digit).
		const noDigits = base.slice(0, 49);
		expect(await parseFontMetrics(noDigits)).toBeNull();
		// Continuation bit set but the file ends before the next digit.
		const midDigits = base.slice(0, 50);
		midDigits[49] = 0x81;
		expect(await parseFontMetrics(midDigits)).toBeNull();
	});

	it("returns null for WOFF2 with a truncated transformLength", async () => {
		const w = woff2([
			{ name: "head", stored: headTable(1000).data },
			{ name: "hmtx", stored: [1, 2], origLength: 9, transformVersion: 1 },
		]);
		// Truncate mid-directory: head's entry is flags+origLength (2
		// bytes, offset 48-49), hmtx's flags+origLength end at offset 52 —
		// its transformLength digit is missing.
		const cut = w.slice(0, 52);
		expect(await parseFontMetrics(cut)).toBeNull();
	});

	it("returns null for WOFF2 whose compressed stream is bad", async () => {
		const w = woff2([{ name: "head", stored: headTable(1000).data }]);
		// Garbage brotli payload → decoder throws.
		const bad = w.slice();
		bad.fill(0xff, bad.length - 8);
		expect(await parseFontMetrics(bad)).toBeNull();
		// totalCompressedSize points past the end of the file.
		const over = w.slice();
		new DataView(over.buffer).setUint32(20, over.length);
		expect(await parseFontMetrics(over)).toBeNull();
	});

	it("returns null for WOFF2 whose decompressed size mismatches", async () => {
		// origLength claims more bytes than are actually stored → the
		// directory's total no longer equals the brotli output size.
		const w = woff2([
			{ name: "head", stored: headTable(1000).data, origLength: 40 },
			{ name: "hhea", stored: hheaTable(1, -1, 0).data },
		]);
		expect(await parseFontMetrics(w)).toBeNull();
	});

	it("returns null for WOFF2 missing or corrupt metric tables", async () => {
		// No head/hhea at all.
		expect(
			await parseFontMetrics(woff2([{ name: "OS/2", stored: os2Table(500).data }])),
		).toBeNull();
		// head present but hhea absent.
		expect(
			await parseFontMetrics(woff2([{ name: "head", stored: headTable(1000).data }])),
		).toBeNull();
		// head shorter than the 20 bytes unitsPerEm needs.
		expect(
			await parseFontMetrics(
				woff2([
					{ name: "head", stored: [0, 0] },
					{ name: "hhea", stored: hheaTable(1, -1, 0).data },
				]),
			),
		).toBeNull();
		// hhea shorter than 10 bytes.
		expect(
			await parseFontMetrics(
				woff2([
					{ name: "head", stored: headTable(1000).data },
					{ name: "hhea", stored: [0, 0] },
				]),
			),
		).toBeNull();
		// unitsPerEm = 0.
		expect(
			await parseFontMetrics(
				woff2([
					{ name: "head", stored: headTable(0).data },
					{ name: "hhea", stored: hheaTable(1, -1, 0).data },
				]),
			),
		).toBeNull();
		// OS/2 shorter than 4 bytes → xAvgCharWidth stays undefined.
		const shortOs2 = await parseFontMetrics(
			woff2([
				{ name: "OS/2", stored: [0, 0] },
				{ name: "head", stored: headTable(1000).data },
				{ name: "hhea", stored: hheaTable(800, -200, 0).data },
			]),
		);
		expect(shortOs2?.xAvgCharWidth).toBeUndefined();
		// A transformed metric table is treated as absent → null.
		expect(
			await parseFontMetrics(
				woff2([
					{ name: "head", stored: headTable(1000).data, origLength: 30, transformVersion: 1 },
					{ name: "hhea", stored: hheaTable(1, -1, 0).data },
				]),
			),
		).toBeNull();
	});

	it("returns null for junk and truncated input", async () => {
		expect(await parseFontMetrics(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(await parseFontMetrics(ttf().slice(0, 8))).toBeNull();
	});

	it("returns null when required tables are absent or corrupt", async () => {
		// head table too short → bounds check fails.
		const shortHead = buildSfnt("true", [table("head", [0, 0]), hheaTable(1, -1, 0)]);
		expect(await parseFontMetrics(shortHead)).toBeNull();
		// unitsPerEm = 0 → rejected.
		const zeroEm = buildSfnt("true", [headTable(0), hheaTable(1, -1, 0)]);
		expect(await parseFontMetrics(zeroEm)).toBeNull();
		// Unknown container without a ttf/otf format hint.
		const weird = buildSfnt("abcd", [headTable(1000), hheaTable(1, -1, 0)]);
		expect(await parseFontMetrics(weird)).toBeNull();
		// …but accepted when the format hints sfnt.
		expect((await parseFontMetrics(weird, "ttf"))?.unitsPerEm).toBe(1000);
	});

	it("returns null for truncated directories and missing metric tables", async () => {
		// Directory claims more tables than the file holds.
		const truncated = new Uint8Array([...tag("true"), ...u16(100), ...new Array(14).fill(0)]);
		expect(await parseFontMetrics(truncated)).toBeNull();
		// Valid directory without head/hhea tables.
		const noMetrics = buildSfnt("true", [os2Table(500), table("cmap", [1, 2, 3])]);
		expect(await parseFontMetrics(noMetrics)).toBeNull();
		// head present but hhea absent.
		const headOnly = buildSfnt("true", [headTable(1000)]);
		expect(await parseFontMetrics(headOnly)).toBeNull();
	});

	it("returns null for short/corrupt WOFF containers", async () => {
		// "wOFF" signature but shorter than the 44-byte header.
		const tinyWoff = new Uint8Array(20);
		tinyWoff.set(tag("wOFF"), 0);
		expect(await parseFontMetrics(tinyWoff)).toBeNull();
		// Single-table WOFF: hhea lookup walks off the record list.
		const headOnlyWoff = woff([headTable(2048)]);
		expect(await parseFontMetrics(headOnlyWoff)).toBeNull();
		// head record points outside the file.
		const badOffset = woff([headTable(2048), hheaTable(1, -1, 0)]);
		badOffset.set(u32(0xfffffff0), 44 + 4);
		expect(await parseFontMetrics(badOffset)).toBeNull();
		// head table shorter than the 20 bytes unitsPerEm needs.
		const shortHeadWoff = woff([table("head", [0, 0]), hheaTable(1, -1, 0)]);
		expect(await parseFontMetrics(shortHeadWoff)).toBeNull();
		// unitsPerEm = 0 inside WOFF.
		const zeroEmWoff = woff([headTable(0), hheaTable(1, -1, 0)]);
		expect(await parseFontMetrics(zeroEmWoff)).toBeNull();
	});

	it("returns null for WOFF containers that are short or truncated", async () => {
		// Valid signature but shorter than the 44-byte header.
		const short = new Uint8Array(20);
		short.set([0x77, 0x4f, 0x46, 0x46], 0); // "wOFF"
		expect(await parseFontMetrics(short)).toBeNull();
		// Header-sized but the single table record is cut off.
		const truncated = new Uint8Array(50);
		truncated.set([0x77, 0x4f, 0x46, 0x46], 0);
		new DataView(truncated.buffer).setUint16(12, 1); // numTables = 1
		expect(await parseFontMetrics(truncated)).toBeNull();
	});

	it("returns null when a compressed WOFF table cannot be inflated", async () => {
		// compLength < origLength with garbage payload → inflate throws.
		const corrupt = woff([headTable(2048), hheaTable(1, -1, 0)]);
		corrupt.set(u32(5), 44 + 8); // compLength
		corrupt.set(u32(20), 44 + 12); // origLength
		// Table 0's data offset is 44 + numTables*20 = 84 — garbage there
		// cannot inflate.
		corrupt.fill(0xff, 84, 89);
		expect(await parseFontMetrics(corrupt)).toBeNull();
	});

	it("returns null when DecompressionStream is unavailable", async () => {
		const compressed = woff([headTable(2048), hheaTable(1, -1, 0)]);
		compressed.set(u32(5), 44 + 8);
		compressed.set(u32(20), 44 + 12);
		vi.stubGlobal("DecompressionStream", undefined);
		try {
			expect(await parseFontMetrics(compressed)).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("tolerates resizable-buffer views that shrink below the directory", async () => {
		// ArrayBuffer resize options need es2024 lib typings — the runtime
		// (Node ≥20) supports them, so cast the constructor for tsc.
		const Rab = ArrayBuffer as unknown as new (
			n: number,
			options?: { maxByteLength?: number },
		) => ArrayBuffer & { resize(newLen: number): void };
		const rab = new Rab(64, { maxByteLength: 128 });
		const view = new Uint8Array(rab, 0, 32);
		view.set(tag("true"), 0);
		rab.resize(8);
		expect(await parseFontMetrics(view)).toBeNull();
	});

	it("returns null when the view claims more bytes than its buffer holds", async () => {
		// A forged view: byteLength/byteOffset pass the early checks and
		// head4 reads "OTTO", but the directory DataView overflows the
		// real buffer — the defensive catch converts it to null.
		const buffer = new ArrayBuffer(60);
		new Uint8Array(buffer, 50, 4).set([0x4f, 0x54, 0x54, 0x4f]); // "OTTO"
		const forged = {
			byteLength: 100,
			byteOffset: 50,
			buffer,
		} as unknown as Uint8Array;
		expect(await parseFontMetrics(forged)).toBeNull();
	});
});

describe("localFontForSlot + FALLBACK_FONT_METRICS", () => {
	it("maps slots to system fonts present in the metrics table", () => {
		expect(localFontForSlot("sans")).toBe("Arial");
		expect(localFontForSlot("heading")).toBe("Arial");
		expect(localFontForSlot("mono")).toBe("Courier New");
		for (const slot of ["sans", "heading", "mono"] as const) {
			expect(FALLBACK_FONT_METRICS[localFontForSlot(slot).toLowerCase()]).toBeDefined();
		}
	});
});

describe("computeMetricOverrides", () => {
	const webfont: FontMetrics = {
		unitsPerEm: 1000,
		ascent: 800,
		descent: -200,
		lineGap: 0,
		xAvgCharWidth: 500,
	};

	it("computes size-adjust from average-width ratios and overrides", () => {
		const fallback = FALLBACK_FONT_METRICS.arial!;
		const m = computeMetricOverrides(webfont, fallback);
		// sizeAdjust% = (500/1000) / (913/2048) * 100 ≈ 112.1577
		expect(m.sizeAdjust).toBeCloseTo(112.16, 2);
		expect(m.ascentOverride).toBeGreaterThan(0);
		expect(m.ascentOverride).toBeLessThan(100);
		expect(m.descentOverride).toBeGreaterThan(0);
		expect(m.lineGapOverride).toBe(0);
	});

	it("falls back to sizeAdjust 100 when widths are missing", () => {
		const noWidth: FontMetrics = { unitsPerEm: 1000, ascent: 800, descent: -200, lineGap: 0 };
		const m = computeMetricOverrides(noWidth, FALLBACK_FONT_METRICS["noto sans"]!);
		expect(m.sizeAdjust).toBe(100);
		expect(m.ascentOverride).toBeCloseTo(80, 5);
	});

	it("falls back to sizeAdjust 100 when the fallback lacks a width", () => {
		const noWidthFallback: FontMetrics = {
			unitsPerEm: 1000,
			ascent: 800,
			descent: -200,
			lineGap: 0,
		};
		const m = computeMetricOverrides(
			{ unitsPerEm: 1000, ascent: 800, descent: -200, lineGap: 0, xAvgCharWidth: 500 },
			noWidthFallback,
		);
		expect(m.sizeAdjust).toBe(100);
	});

	it("returns finite overrides when the fallback ratio is zero", () => {
		const zeroRatio: FontMetrics = {
			unitsPerEm: 1000,
			ascent: 1,
			descent: -1,
			lineGap: 0,
			xAvgCharWidth: 0,
		};
		const m = computeMetricOverrides(webfont, zeroRatio);
		expect(Number.isFinite(m.sizeAdjust)).toBe(true);
	});
});
