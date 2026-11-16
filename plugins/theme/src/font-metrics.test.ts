import { describe, expect, it } from "vitest";

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
const tag = (s: string) => [...s].map((c) => c.charCodeAt(0));

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

	it("returns null for WOFF2 (brotli — documented TODO), junk and truncated input", async () => {
		expect(await parseFontMetrics(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(await parseFontMetrics(ttf().slice(0, 8))).toBeNull();
		const woff2 = new Uint8Array([...tag("wOF2"), ...new Array(40).fill(0)]);
		expect(await parseFontMetrics(woff2)).toBeNull();
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
