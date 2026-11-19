import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findTable } from "./font-metrics.ts";
import { LATIN_SUBSET_RANGES, latinSubsetCodepoints, subsetCatalogFont } from "./font-subset.ts";
import type { FontVariationInfo } from "./font-variations.ts";

const fixtureTtf = new Uint8Array(
	readFileSync(fileURLToPath(new URL("./testdata/katex-size3.ttf", import.meta.url))),
);

const staticVariation = (
	coverageRanges: readonly (readonly [number, number])[],
	over: Partial<FontVariationInfo> = {},
): FontVariationInfo => ({ variable: false, coverageRanges, ...over });

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> =>
	new Uint8Array(
		await new Response(
			new Blob([bytes.slice().buffer as ArrayBuffer])
				.stream()
				.pipeThrough(new CompressionStream("deflate")),
		).arrayBuffer(),
	);

interface SfntTable {
	readonly tag: string;
	readonly data: Uint8Array;
}

/** Split the fixture TTF into its sfnt tables. */
const sfntTables = (bytes: Uint8Array): SfntTable[] => {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const num = v.getUint16(4);
	const out: SfntTable[] = [];
	for (let i = 0; i < num; i++) {
		const o = 12 + i * 16;
		const tag = String.fromCharCode(
			v.getUint8(o),
			v.getUint8(o + 1),
			v.getUint8(o + 2),
			v.getUint8(o + 3),
		);
		const off = v.getUint32(o + 8);
		const len = v.getUint32(o + 12);
		out.push({ tag, data: bytes.subarray(off, off + len) });
	}
	return out;
};

interface WoffRecSpec {
	readonly tag: string;
	readonly data: Uint8Array;
	/** Store raw (compLen === origLength) instead of deflating. */
	readonly raw?: boolean;
	readonly origLengthOverride?: number;
}

/** Build a WOFF container around the given table specs. Table data
 * offsets are absolute file offsets, matching the WOFF spec (and
 * font-metrics.ts's woffTable reader). */
const woff = async (flavor: number, recs: readonly WoffRecSpec[]): Promise<Uint8Array> => {
	const compressed = await Promise.all(
		recs.map(async (r) => (r.raw === true ? r.data.slice() : deflate(r.data))),
	);
	const headerBytes = 44 + recs.length * 20;
	const offsets: number[] = [];
	let cursor = headerBytes;
	for (let i = 0; i < recs.length; i++) {
		cursor = (cursor + 3) & ~3;
		offsets.push(cursor);
		cursor += compressed[i]!.byteLength;
	}
	const out = new Uint8Array(cursor);
	const v = new DataView(out.buffer);
	v.setUint32(0, 0x774f4646); // "wOFF"
	v.setUint32(4, flavor);
	v.setUint32(8, out.byteLength);
	v.setUint16(12, recs.length);
	v.setUint16(14, 0);
	for (let i = 0; i < recs.length; i++) {
		const r = recs[i]!;
		const o = 44 + i * 20;
		for (let c = 0; c < 4; c++) v.setUint8(o + c, r.tag.charCodeAt(c));
		v.setUint32(o + 4, offsets[i]!);
		v.setUint32(o + 8, compressed[i]!.byteLength);
		v.setUint32(o + 12, r.origLengthOverride ?? r.data.byteLength);
		v.setUint32(o + 16, 0);
		out.set(compressed[i]!, offsets[i]!);
	}
	return out;
};

/** WOFF wrapping every table of the fixture TTF (one stored raw to
 * cover the compLen === origLength path). */
const fixtureWoff = async (): Promise<Uint8Array> => {
	const tables = sfntTables(fixtureTtf);
	return woff(
		0x00010000,
		tables.map((t, i) => ({
			tag: t.tag,
			data: t.data,
			raw: i === 0,
		})),
	);
};

describe("latinSubsetCodepoints", () => {
	it("expands the latin ranges into a sorted flat list", () => {
		const cps = latinSubsetCodepoints();
		expect(cps.length).toBeGreaterThan(300);
		expect(cps[0]).toBe(0x00);
		expect(cps).toContain(0x41); // 'A'
		expect(cps).toContain(0x20ac); // €
		expect([...cps].sort((a, b) => a - b)).toEqual([...cps]);
	});

	it("LATIN_SUBSET_RANGES is sorted and non-overlapping", () => {
		for (let i = 1; i < LATIN_SUBSET_RANGES.length; i++) {
			expect(LATIN_SUBSET_RANGES[i]![0]).toBeGreaterThan(LATIN_SUBSET_RANGES[i - 1]![1]);
		}
	});
});

describe("subsetCatalogFont", () => {
	it("returns null without variation info, for variable fonts and empty coverage", async () => {
		expect(await subsetCatalogFont({ bytes: fixtureTtf, variation: null })).toBeNull();
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation: { variable: true, coverageRanges: [[0x20, 0x7e]] },
			}),
		).toBeNull();
		expect(
			await subsetCatalogFont({ bytes: fixtureTtf, variation: { variable: false } }),
		).toBeNull();
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation: staticVariation([]),
			}),
		).toBeNull();
	});

	it("skips WOFF2 containers and non-sfnt payloads", async () => {
		const woff2Magic = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
		expect(
			await subsetCatalogFont({
				bytes: woff2Magic,
				variation: staticVariation([[0x20, 0x7e]]),
			}),
		).toBeNull();
		// Random bytes → no sfnt flavor.
		expect(
			await subsetCatalogFont({
				bytes: new Uint8Array([9, 9, 9, 9, 1, 2, 3, 4]),
				variation: staticVariation([[0x20, 0x7e]]),
			}),
		).toBeNull();
	});

	it("produces a smaller latin subset plus a complement range for a TTF", async () => {
		const plan = await subsetCatalogFont({
			bytes: fixtureTtf,
			variation: staticVariation([
				[0x20, 0x7e],
				[0x400, 0x4ff],
			]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.ext).toBe("ttf");
		expect(plan!.format).toBe("truetype");
		expect(plan!.data.byteLength).toBeLessThan(fixtureTtf.byteLength);
		// Coverage ∩ latin = U+0020-007E; complement = U+0400-04FF.
		expect(plan!.unicodeRange).toBe("U+0020-007E");
		expect(plan!.fullUnicodeRange).toBe("U+0400-04FF");
		// The subset is itself a parseable sfnt.
		expect(findTable(plan!.data, "head")).not.toBeNull();
		expect(findTable(plan!.data, "cmap")).not.toBeNull();
	});

	it("omits fullUnicodeRange when coverage is entirely latin", async () => {
		const plan = await subsetCatalogFont({
			bytes: fixtureTtf,
			variation: staticVariation([[0x41, 0x5a]]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.unicodeRange).toBe("U+0041-005A");
		expect(plan!.fullUnicodeRange).toBeUndefined();
	});

	it("splits partially-overlapping coverage into disjoint ranges", async () => {
		// 0x131 and 0x152-0x153 are latin singles inside the covered span;
		// 0x2060-0x2065 sits inside the latin punctuation block and drops
		// out of the complement entirely.
		const plan = await subsetCatalogFont({
			bytes: fixtureTtf,
			variation: staticVariation([
				[0x100, 0x250],
				[0x400, 0x4ff],
				[0x2060, 0x2065],
			]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.unicodeRange).toBe("U+0131, U+0152-0153, U+2060-2065");
		expect(plan!.fullUnicodeRange).toBe("U+0100-0130, U+0132-0151, U+0154-0250, U+0400-04FF");
	});

	it("drops the complement when coverage sits inside a latin block", async () => {
		const plan = await subsetCatalogFont({
			bytes: fixtureTtf,
			variation: staticVariation([[0x2060, 0x2065]]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.unicodeRange).toBe("U+2060-2065");
		expect(plan!.fullUnicodeRange).toBeUndefined();
	});

	it("unpacks WOFF uploads to sfnt before subsetting", async () => {
		const woffBytes = await fixtureWoff();
		const plan = await subsetCatalogFont({
			bytes: woffBytes,
			variation: staticVariation([[0x20, 0x7e]]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.ext).toBe("ttf");
		expect(plan!.data.byteLength).toBeLessThan(woffBytes.byteLength);
	});

	it("returns null for latin-less coverage and unserializable complements", async () => {
		// Coverage entirely outside latin → empty intersection.
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation: staticVariation([[0x400, 0x4ff]]),
			}),
		).toBeNull();
		// Huge complement → serialized descriptor exceeds the cap.
		const wide: [number, number][] = [[0x20, 0x7e]];
		for (let cp = 0x1000; cp < 0x8000; cp += 0x21) {
			wide.push([cp, cp]);
		}
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation: staticVariation(wide),
			}),
		).toBeNull();
	});

	it("rejects malformed WOFF containers", async () => {
		const variation = staticVariation([[0x20, 0x7e]]);
		// Header too short for the 44-byte WOFF header.
		expect(
			await subsetCatalogFont({
				bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 0]),
				variation,
			}),
		).toBeNull();
		// numTables = 0.
		const zeroTables = new Uint8Array(44);
		zeroTables.set([0x77, 0x4f, 0x46, 0x46], 0);
		expect(await subsetCatalogFont({ bytes: zeroTables, variation })).toBeNull();
		// Directory records run past the buffer.
		const hugeCount = new Uint8Array(60);
		hugeCount.set([0x77, 0x4f, 0x46, 0x46], 0);
		new DataView(hugeCount.buffer).setUint16(12, 0xffff);
		expect(await subsetCatalogFont({ bytes: hugeCount, variation })).toBeNull();
		// Table data offset beyond the buffer.
		const badOffset = await woff(0x00010000, [{ tag: "cmap", data: new Uint8Array([1, 2, 3]) }]);
		new DataView(badOffset.buffer).setUint32(44 + 4, 0xfffff0);
		expect(await subsetCatalogFont({ bytes: badOffset, variation })).toBeNull();
		// Corrupt deflate stream — hand-built record whose compressed
		// payload is not a zlib stream at all.
		const badZlib = new Uint8Array(44 + 20 + 10);
		badZlib.set([0x77, 0x4f, 0x46, 0x46], 0);
		const zv = new DataView(badZlib.buffer);
		zv.setUint32(4, 0x00010000);
		zv.setUint16(12, 1);
		badZlib.set([0x63, 0x6d, 0x61, 0x70], 44); // "cmap"
		zv.setUint32(48, 64);
		zv.setUint32(52, 10);
		zv.setUint32(56, 20);
		badZlib.fill(0xab, 64);
		expect(await subsetCatalogFont({ bytes: badZlib, variation })).toBeNull();
		// Inflated length disagrees with origLength.
		const short = await woff(0x00010000, [
			{
				tag: "cmap",
				data: new Uint8Array(64).fill(1),
				origLengthOverride: 4096,
			},
		]);
		expect(await subsetCatalogFont({ bytes: short, variation })).toBeNull();
		// Claimed uncompressed size beyond the sfnt cap — a zlib-bomb
		// style header must not trigger a giant allocation.
		const bomb = await woff(0x00010000, [
			{
				tag: "cmap",
				data: new Uint8Array(64).fill(1),
				origLengthOverride: 128 * 1024 * 1024,
			},
		]);
		expect(await subsetCatalogFont({ bytes: bomb, variation })).toBeNull();
		// Unpacked sfnt flavor is not a recognized sfnt signature.
		const badFlavor = await woff(0xdeadbeef, [{ tag: "cmap", data: new Uint8Array([1, 2, 3, 4]) }]);
		expect(await subsetCatalogFont({ bytes: badFlavor, variation })).toBeNull();
	});

	it("returns null when DecompressionStream is unavailable", async () => {
		const original = globalThis.DecompressionStream;
		// @ts-expect-error -- simulating a runtime without the API
		globalThis.DecompressionStream = undefined;
		try {
			const woffBytes = await fixtureWoff();
			expect(
				await subsetCatalogFont({
					bytes: woffBytes,
					variation: staticVariation([[0x20, 0x7e]]),
				}),
			).toBeNull();
		} finally {
			globalThis.DecompressionStream = original;
		}
	});

	it("returns null for sfnt payloads missing head/cmap or failing the size guard", async () => {
		const variation = staticVariation([[0x20, 0x7e]]);
		// OTTO signature with a directory lacking head/cmap.
		const otto = new Uint8Array(64);
		otto.set([0x4f, 0x54, 0x54, 0x4f], 0); // "OTTO"
		new DataView(otto.buffer).setUint16(4, 1); // one table, none present
		expect(await subsetCatalogFont({ bytes: otto, variation })).toBeNull();
		// head present but cmap absent.
		const headOnly = new Uint8Array(12 + 16 + 54);
		headOnly.set([0, 1, 0, 0], 0);
		const hv = new DataView(headOnly.buffer);
		hv.setUint16(4, 1);
		headOnly.set([0x68, 0x65, 0x61, 0x64], 12); // "head"
		hv.setUint32(12 + 8, 28);
		hv.setUint32(12 + 12, 54);
		expect(await subsetCatalogFont({ bytes: headOnly, variation })).toBeNull();
		// Subsetter failure and non-shrinking/invalid outputs all degrade
		// to null (the route keeps the full font).
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation,
				subsetFont: () => null,
			}),
		).toBeNull();
		// Equal-size output → no win → null.
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation,
				subsetFont: () => new Uint8Array(fixtureTtf.byteLength),
			}),
		).toBeNull();
		// Smaller but not a recognizable sfnt → null.
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation,
				subsetFont: () => new Uint8Array([1, 2, 3]),
			}),
		).toBeNull();
		// A throwing subsetter (e.g. wasm module resolution failure)
		// degrades the same way.
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation,
				subsetFont: () => {
					throw new Error("wasm unavailable");
				},
			}),
		).toBeNull();
	});
});
