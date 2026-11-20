import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findTable } from "./font-metrics.ts";
import { FONT_SUBSET_CHARSETS, LATIN_SUBSET_RANGES, subsetCatalogFont } from "./font-subset.ts";
import { parseFontVariations, type FontVariationInfo } from "./font-variations.ts";

const fixtureTtf = new Uint8Array(
	readFileSync(fileURLToPath(new URL("./testdata/katex-size3.ttf", import.meta.url))),
);
// Roboto Variable (wght + wdth axes, glyf/gvar outlines) — upstream
// hb-subset-wasm test fixture, Apache-2.0. Covers only U+0041-0043.
const fixtureVariableTtf = new Uint8Array(
	readFileSync(fileURLToPath(new URL("./testdata/Roboto-Variable.ABC.ttf", import.meta.url))),
);
const fixtureWoff2 = new Uint8Array(
	readFileSync(fileURLToPath(new URL("./testdata/katex-size3.woff2", import.meta.url))),
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

/** Minimal sfnt directory carrying the given table tags — enough for
 * sfntFlavor/findTable; table payloads are never dereferenced. Inputs
 * must also list "head" and "cmap" to pass the directory guard. */
const fakeSfnt = (tags: readonly string[], size = 512): Uint8Array => {
	const out = new Uint8Array(size);
	const v = new DataView(out.buffer);
	out.set([0, 1, 0, 0], 0); // 0x00010000 → "ttf" flavor
	v.setUint16(4, tags.length);
	for (let i = 0; i < tags.length; i++) {
		const o = 12 + i * 16;
		for (let c = 0; c < 4; c++) out[o + c] = tags[i]!.charCodeAt(c);
		v.setUint32(o + 8, size);
		v.setUint32(o + 12, 0);
	}
	return out;
};

describe("FONT_SUBSET_CHARSETS", () => {
	it("has unique names and sorted, non-overlapping ranges per charset", () => {
		const names = FONT_SUBSET_CHARSETS.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names[0]).toBe("latin");
		for (const charset of FONT_SUBSET_CHARSETS) {
			for (let i = 1; i < charset.ranges.length; i++) {
				expect(charset.ranges[i]![0]).toBeGreaterThan(charset.ranges[i - 1]![1]);
			}
		}
	});

	it("keeps charset ranges inside valid Unicode and bounded in size", () => {
		for (const charset of FONT_SUBSET_CHARSETS) {
			let count = 0;
			for (const [start, stop] of charset.ranges) {
				expect(start).toBeGreaterThanOrEqual(0);
				expect(stop).toBeLessThanOrEqual(0x10ffff);
				expect(stop).toBeGreaterThanOrEqual(start);
				count += stop - start + 1;
			}
			// No charset may approach the whole codespace — that is what
			// keeps per-charset codepoint expansion cheap.
			expect(count).toBeLessThan(0x110000);
		}
	});

	it("LATIN_SUBSET_RANGES matches the latin charset entry", () => {
		expect(FONT_SUBSET_CHARSETS[0]!.ranges).toBe(LATIN_SUBSET_RANGES);
		for (let i = 1; i < LATIN_SUBSET_RANGES.length; i++) {
			expect(LATIN_SUBSET_RANGES[i]![0]).toBeGreaterThan(LATIN_SUBSET_RANGES[i - 1]![1]);
		}
	});
});

describe("subsetCatalogFont", () => {
	it("returns null without variation info and for empty coverage", async () => {
		expect(await subsetCatalogFont({ bytes: fixtureTtf, variation: null })).toBeNull();
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

	it("rejects truncated WOFF2 containers and non-sfnt payloads", async () => {
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
				// Armenian — inside no charset group, so it stays in the
				// full-font complement.
				[0x530, 0x58f],
			]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets).toHaveLength(1);
		expect(plan!.subsets[0]!.charset).toBe("latin");
		expect(plan!.subsets[0]!.ext).toBe("ttf");
		expect(plan!.subsets[0]!.format).toBe("truetype");
		expect(plan!.subsets[0]!.data.byteLength).toBeLessThan(fixtureTtf.byteLength);
		// Coverage ∩ latin = U+0020-007E; complement = U+0530-058F.
		expect(plan!.subsets[0]!.unicodeRange).toBe("U+0020-007E");
		expect(plan!.fullUnicodeRange).toBe("U+0530-058F");
		// The subset is itself a parseable sfnt.
		expect(findTable(plan!.subsets[0]!.data, "head")).not.toBeNull();
		expect(findTable(plan!.subsets[0]!.data, "cmap")).not.toBeNull();
	});

	it("omits fullUnicodeRange when coverage is entirely latin", async () => {
		const plan = await subsetCatalogFont({
			bytes: fixtureTtf,
			variation: staticVariation([[0x41, 0x5a]]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets[0]!.unicodeRange).toBe("U+0041-005A");
		expect(plan!.fullUnicodeRange).toBeUndefined();
	});

	it("emits one disjoint subset per covered charset", async () => {
		// 0x131 and 0x152-0x153 are latin singles inside the covered
		// span; 0x2060-0x2065 sits inside the latin punctuation block.
		// The 0x100-0x250 span lands in latin-ext, 0x400-0x4FF splits
		// across cyrillic/cyrillic-ext — every charset claims only the
		// coverage earlier charsets did not take.
		const plan = await subsetCatalogFont({
			bytes: fixtureTtf,
			variation: staticVariation([
				[0x100, 0x250],
				[0x400, 0x4ff],
				[0x2060, 0x2065],
			]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets.map((s) => s.charset)).toEqual([
			"latin",
			"latin-ext",
			"cyrillic",
			"cyrillic-ext",
		]);
		expect(plan!.subsets.map((s) => s.unicodeRange)).toEqual([
			"U+0131, U+0152-0153, U+2060-2065",
			"U+0100-0130, U+0132-0151, U+0154-0250",
			// Cyrillic's supplementary repertoire singles ride along.
			"U+0400-045F, U+0490-0491, U+04B0-04B1",
			"U+0460-048F, U+0492-04AF, U+04B2-04FF",
		]);
		// Every codepoint is claimed → no full-font face.
		expect(plan!.fullUnicodeRange).toBeUndefined();
	});

	it("drops the complement when coverage sits inside a latin block", async () => {
		const plan = await subsetCatalogFont({
			bytes: fixtureTtf,
			variation: staticVariation([[0x2060, 0x2065]]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets[0]!.unicodeRange).toBe("U+2060-2065");
		expect(plan!.fullUnicodeRange).toBeUndefined();
	});

	it("unpacks WOFF uploads to sfnt before subsetting", async () => {
		const woffBytes = await fixtureWoff();
		const plan = await subsetCatalogFont({
			bytes: woffBytes,
			variation: staticVariation([[0x20, 0x7e]]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets[0]!.ext).toBe("ttf");
		expect(plan!.subsets[0]!.data.byteLength).toBeLessThan(woffBytes.byteLength);
	});

	it("reconstructs WOFF2 uploads and subsets them to sfnt", async () => {
		const plan = await subsetCatalogFont({
			bytes: fixtureWoff2,
			variation: staticVariation([[0x20, 0x7e]]),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets[0]!.ext).toBe("ttf");
		expect(plan!.subsets[0]!.format).toBe("truetype");
		expect(plan!.subsets[0]!.data.byteLength).toBeLessThan(fixtureWoff2.byteLength);
		expect(findTable(plan!.subsets[0]!.data, "head")).not.toBeNull();
		expect(findTable(plan!.subsets[0]!.data, "cmap")).not.toBeNull();
	});

	it("keeps the full font when WOFF2 reconstruction fails", async () => {
		// Valid wOF2 magic but a corrupt body → woff2ToSfnt returns null.
		const corrupt = new Uint8Array(fixtureWoff2);
		corrupt[48] = 0xff; // smash the first directory byte
		corrupt[49] = 0xff;
		expect(
			await subsetCatalogFont({
				bytes: corrupt,
				variation: staticVariation([[0x20, 0x7e]]),
			}),
		).toBeNull();
		// Truncated WOFF2.
		expect(
			await subsetCatalogFont({
				bytes: fixtureWoff2.slice(0, 100),
				variation: staticVariation([[0x20, 0x7e]]),
			}),
		).toBeNull();
	});

	it("keeps the full font when the WOFF2 subset fails or is not smaller", async () => {
		// Subsetter seam returns null → degrade to full font.
		expect(
			await subsetCatalogFont({
				bytes: fixtureWoff2,
				variation: staticVariation([[0x20, 0x7e]]),
				subsetFont: () => null,
			}),
		).toBeNull();
	});

	it("returns null for charset-less coverage and unserializable complements", async () => {
		// Coverage entirely outside every charset group (Armenian) →
		// no subset applies.
		expect(
			await subsetCatalogFont({
				bytes: fixtureTtf,
				variation: staticVariation([[0x530, 0x58f]]),
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

	it("subsets a real variable font when fvar/gvar survive", async () => {
		const variation = await parseFontVariations(fixtureVariableTtf);
		expect(variation?.variable).toBe(true);
		const plan = await subsetCatalogFont({ bytes: fixtureVariableTtf, variation });
		expect(plan).not.toBeNull();
		expect(plan!.subsets[0]!.data.byteLength).toBeLessThan(fixtureVariableTtf.byteLength);
		expect(plan!.subsets[0]!.ext).toBe("ttf");
		// The subset provably kept the variation machinery — the
		// @font-face weightRange/axes descriptors stay honest.
		expect(findTable(plan!.subsets[0]!.data, "fvar")).not.toBeNull();
		expect(findTable(plan!.subsets[0]!.data, "gvar")).not.toBeNull();
		const reparsed = await parseFontVariations(plan!.subsets[0]!.data);
		expect(reparsed?.variable).toBe(true);
		expect(reparsed?.weightAxis).toEqual(variation!.weightAxis);
		expect(reparsed?.axes).toEqual(variation!.axes);
	});

	it("subsets variable fonts wrapped in WOFF", async () => {
		const woffBytes = await woff(
			0x00010000,
			sfntTables(fixtureVariableTtf).map((t) => ({ tag: t.tag, data: t.data })),
		);
		const variation = await parseFontVariations(woffBytes, "woff");
		const plan = await subsetCatalogFont({ bytes: woffBytes, variation });
		expect(plan).not.toBeNull();
		expect(findTable(plan!.subsets[0]!.data, "fvar")).not.toBeNull();
		expect(findTable(plan!.subsets[0]!.data, "gvar")).not.toBeNull();
	});

	it("keeps the subset when the input carries no gvar/CFF2", async () => {
		// fvar-only variable font (no outline-variation tables) — only
		// the fvar record must survive.
		const input = fakeSfnt(["head", "cmap", "fvar"]);
		const plan = await subsetCatalogFont({
			bytes: input,
			variation: { variable: true, coverageRanges: [[0x20, 0x7e]] },
			subsetFont: () => fakeSfnt(["head", "cmap", "fvar"], 128),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets[0]!.unicodeRange).toBe("U+0020-007E");
	});

	it("rejects variable subsets that drop fvar, gvar or CFF2", async () => {
		const variation = { variable: true, coverageRanges: [[0x20, 0x7e]] } as const;
		// Output lost fvar entirely → static font under a variable
		// descriptor.
		expect(
			await subsetCatalogFont({
				bytes: fakeSfnt(["head", "cmap", "fvar"]),
				variation,
				subsetFont: () => fakeSfnt(["head", "cmap"], 128),
			}),
		).toBeNull();
		// TrueType-outline variable font whose subset lost gvar.
		expect(
			await subsetCatalogFont({
				bytes: fakeSfnt(["head", "cmap", "fvar", "gvar"]),
				variation,
				subsetFont: () => fakeSfnt(["head", "cmap", "fvar"], 128),
			}),
		).toBeNull();
		// CFF2-outline variable font whose subset lost CFF2.
		expect(
			await subsetCatalogFont({
				bytes: fakeSfnt(["head", "cmap", "fvar", "CFF2"]),
				variation,
				subsetFont: () => fakeSfnt(["head", "cmap", "fvar"], 128),
			}),
		).toBeNull();
		// CFF2 retained alongside fvar → accepted.
		const plan = await subsetCatalogFont({
			bytes: fakeSfnt(["head", "cmap", "fvar", "CFF2"]),
			variation,
			subsetFont: () => fakeSfnt(["head", "cmap", "fvar", "CFF2"], 128),
		});
		expect(plan).not.toBeNull();
	});

	it("builds multi-charset plans with disjoint faces via the subsetter seam", async () => {
		const input = fakeSfnt(["head", "cmap"], 4096);
		const calls: number[][] = [];
		const plan = await subsetCatalogFont({
			bytes: input,
			variation: staticVariation([
				[0x20, 0x7e], // latin
				[0x3b1, 0x3c9], // greek
				[0x400, 0x45f], // cyrillic
				[0x530, 0x58f], // Armenian — no charset → complement
			]),
			subsetFont: (_font, unicodes) => {
				calls.push([...unicodes]);
				return fakeSfnt(["head", "cmap"], 256);
			},
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets.map((s) => s.charset)).toEqual(["latin", "cyrillic", "greek"]);
		expect(plan!.subsets.map((s) => s.unicodeRange)).toEqual([
			"U+0020-007E",
			"U+0400-045F",
			"U+03B1-03C9",
		]);
		expect(plan!.fullUnicodeRange).toBe("U+0530-058F");
		// Each subsetter call received only its charset's codepoints.
		expect(calls).toHaveLength(3);
		expect(calls[0]).toContain(0x41);
		expect(calls[0]).not.toContain(0x410);
		expect(calls[1]).toContain(0x410);
		expect(calls[2]).toContain(0x3b1);
	});

	it("skips a failing charset but keeps the others", async () => {
		const input = fakeSfnt(["head", "cmap"], 4096);
		const plan = await subsetCatalogFont({
			bytes: input,
			variation: staticVariation([
				[0x20, 0x7e],
				[0x3b1, 0x3c9],
				[0x400, 0x45f],
			]),
			subsetFont: (_font, unicodes) =>
				unicodes.includes(0x410) ? null : fakeSfnt(["head", "cmap"], 256),
		});
		expect(plan).not.toBeNull();
		// Cyrillic dropped; its coverage falls back into the full face.
		expect(plan!.subsets.map((s) => s.charset)).toEqual(["latin", "greek"]);
		expect(plan!.fullUnicodeRange).toBe("U+0400-045F");
	});

	it("skips charsets fully shadowed by earlier ones", async () => {
		// U+0102-0103 sits in BOTH latin-ext and vietnamese — latin-ext
		// wins, so vietnamese produces no file.
		const input = fakeSfnt(["head", "cmap"], 4096);
		const plan = await subsetCatalogFont({
			bytes: input,
			variation: staticVariation([[0x102, 0x103]]),
			subsetFont: () => fakeSfnt(["head", "cmap"], 256),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets.map((s) => s.charset)).toEqual(["latin-ext"]);
		expect(plan!.subsets[0]!.unicodeRange).toBe("U+0102-0103");
		expect(plan!.fullUnicodeRange).toBeUndefined();
	});

	it("skips a charset whose assigned ranges cannot be serialized", async () => {
		// Sparse single-codepoint coverage all over latin-ext's high
		// ranges → hundreds of tiny ranges → unicode-range descriptor
		// blows the emit cap → charset skipped, plan degrades to null
		// (no other charset has coverage here).
		const wide: [number, number][] = [];
		for (const [lo, hi] of [
			[0x1d00, 0x1dbf],
			[0x1e00, 0x1e9f],
			[0xa720, 0xa7ff],
		] as const) {
			for (let cp = lo; cp <= hi; cp++) wide.push([cp, cp]);
		}
		expect(
			await subsetCatalogFont({
				bytes: fakeSfnt(["head", "cmap"], 4096),
				variation: staticVariation(wide),
				subsetFont: () => fakeSfnt(["head", "cmap"], 256),
			}),
		).toBeNull();
	});

	it("caps total subset bytes and skips non-shrinking subsets", async () => {
		// 6MB fake input so 3MB subsets pass the per-file size guard.
		const input = fakeSfnt(["head", "cmap"], 6 * 1024 * 1024);
		const plan = await subsetCatalogFont({
			bytes: input,
			variation: staticVariation([
				[0x20, 0x7e],
				[0x3b1, 0x3c9],
				[0x400, 0x45f],
			]),
			// Each subset is 3MB — the first fits the 4MB total budget,
			// every later one would exceed it.
			subsetFont: () => fakeSfnt(["head", "cmap"], 3 * 1024 * 1024),
		});
		expect(plan).not.toBeNull();
		expect(plan!.subsets.map((s) => s.charset)).toEqual(["latin"]);
		// A subset not smaller than the upload is skipped per charset.
		const staticInput = fakeSfnt(["head", "cmap"], 256);
		const noWin = await subsetCatalogFont({
			bytes: staticInput,
			variation: staticVariation([
				[0x20, 0x7e],
				[0x400, 0x45f],
			]),
			subsetFont: () => fakeSfnt(["head", "cmap"], 256),
		});
		expect(noWin).toBeNull();
	});
});
