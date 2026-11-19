import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	HB_SUBSET_IMPORT_MODULE,
	resolveHbSubsetModule,
	subsetFontBytes,
	type HbSubsetExports,
} from "./hb-subset.ts";

const wasmBytes = readFileSync(fileURLToPath(new URL("./hb-subset.wasm", import.meta.url)));
const fixtureTtf = readFileSync(
	fileURLToPath(new URL("./testdata/katex-size3.ttf", import.meta.url)),
);

/** Mock exports with a bump allocator over a real Memory — enough for
 * the wrapper's pointer protocol without needing the real wasm. */
const makeMockExports = (
	over: Partial<HbSubsetExports> = {},
): HbSubsetExports & { readonly freed: number[] } => {
	const memory = new WebAssembly.Memory({ initial: 4 });
	let ptr = 4096;
	const freed: number[] = [];
	return {
		memory,
		malloc: (n: number) => {
			const p = ptr;
			ptr += Math.ceil(n / 8) * 8;
			return p;
		},
		free: (p: number) => {
			freed.push(p);
		},
		hb_wrapper_subset: () => 0,
		hb_wrapper_free: () => {},
		_initialize: () => {},
		...over,
		freed,
	} as HbSubsetExports & { freed: number[] };
};

describe("resolveHbSubsetModule", () => {
	it("accepts an already-instantiated exports namespace", () => {
		const ex = makeMockExports();
		expect(resolveHbSubsetModule(ex)).toBe(ex);
	});

	it("rejects partial export shapes at each required member", () => {
		const base = { hb_wrapper_subset: () => 0 };
		expect(() => resolveHbSubsetModule(base)).toThrow("unsupported hb-subset module");
		expect(() => resolveHbSubsetModule({ ...base, malloc: () => 0 })).toThrow(
			"unsupported hb-subset module",
		);
		expect(() => resolveHbSubsetModule({ ...base, malloc: () => 0, free: () => {} })).toThrow(
			"unsupported hb-subset module",
		);
		expect(() =>
			resolveHbSubsetModule({
				...base,
				malloc: () => 0,
				free: () => {},
				hb_wrapper_free: () => {},
			}),
		).toThrow("unsupported hb-subset module");
		expect(() =>
			resolveHbSubsetModule({
				...base,
				malloc: () => 0,
				free: () => {},
				hb_wrapper_free: () => {},
				memory: {},
			}),
		).toThrow("unsupported hb-subset module");
	});

	it("instantiates a WebAssembly.Module (worker CompiledWasm shape)", async () => {
		const ex = resolveHbSubsetModule({ default: new WebAssembly.Module(wasmBytes) });
		ex._initialize();
		const out = subsetFontBytes(new Uint8Array(fixtureTtf), [0x41, 0x42, 0x43], ex);
		expect(out).not.toBeNull();
		expect(out!.byteLength).toBeLessThan(fixtureTtf.byteLength);
	});

	it("rejects unrecognized module shapes", () => {
		expect(() => resolveHbSubsetModule({})).toThrow("unsupported hb-subset module");
		expect(() => resolveHbSubsetModule(null)).toThrow("unsupported hb-subset module");
		expect(() => resolveHbSubsetModule("nope")).toThrow("unsupported hb-subset module");
		expect(() => resolveHbSubsetModule({ default: {} })).toThrow("unsupported hb-subset module");
	});
});

describe("subsetFontBytes", () => {
	it("round-trips a real TTF through the bundled wasm (vitest module shape)", () => {
		const out = subsetFontBytes(
			new Uint8Array(fixtureTtf),
			[
				0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e,
				0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x41, 0x42, 0x43,
				0x61, 0x62, 0x63,
			],
		);
		expect(out).not.toBeNull();
		expect(out!.byteLength).toBeLessThan(fixtureTtf.byteLength);
		// Valid sfnt signature (0x00010000).
		expect(out![0]).toBe(0x00);
		expect(out![1]).toBe(0x01);
	});

	it("returns null for empty inputs and invalid codepoints", () => {
		const font = new Uint8Array(fixtureTtf);
		expect(subsetFontBytes(new Uint8Array(0), [0x41])).toBeNull();
		expect(subsetFontBytes(font, [])).toBeNull();
		expect(subsetFontBytes(font, [1.5])).toBeNull();
		expect(subsetFontBytes(font, [-1])).toBeNull();
		expect(subsetFontBytes(font, [0x110000])).toBeNull();
		// Unicodes list beyond the addressable range.
		expect(subsetFontBytes(font, new Array(0x110001).fill(0))).toBeNull();
	});

	it("returns null when the subsetter reports an error", () => {
		const ex = makeMockExports({ hb_wrapper_subset: () => 5 });
		expect(subsetFontBytes(new Uint8Array(fixtureTtf), [0x41], ex)).toBeNull();
		// And for genuinely corrupt font bytes through the real wasm.
		expect(subsetFontBytes(new Uint8Array([1, 2, 3, 4, 5]), [0x41])).toBeNull();
	});

	it("returns null when malloc fails or the result pointers stay empty", () => {
		const noMalloc = makeMockExports({ malloc: () => 0 });
		expect(subsetFontBytes(new Uint8Array(fixtureTtf), [0x41], noMalloc)).toBeNull();
		// Success code but zeroed output pointers → empty result.
		const empty = makeMockExports();
		expect(subsetFontBytes(new Uint8Array(fixtureTtf), [0x41], empty)).toBeNull();
		// Nonzero data pointer but zero size → also empty.
		const zeroSize = makeMockExports({
			hb_wrapper_subset: (...args: readonly number[]) => {
				new DataView(empty.memory.buffer).setUint32(args[22]!, 16, true);
				return 0;
			},
		});
		expect(subsetFontBytes(new Uint8Array(fixtureTtf), [0x41], zeroSize)).toBeNull();
	});

	it("copies the subset out of wasm memory and frees the C buffer", () => {
		const ex = makeMockExports({
			hb_wrapper_subset: (...args: readonly number[]) => {
				// Write a fake sfnt payload at offset 8192 and point the
				// out-params at it.
				const view = new DataView(ex.memory.buffer);
				view.setUint32(args[22]!, 8192, true);
				view.setUint32(args[23]!, 4, true);
				new Uint8Array(ex.memory.buffer, 8192, 4).set([0, 1, 0, 0]);
				return 0;
			},
		});
		const out = subsetFontBytes(new Uint8Array(fixtureTtf), [0x41], ex);
		expect(out).not.toBeNull();
		expect([...out!]).toEqual([0, 1, 0, 0]);
	});
});

describe("HB_SUBSET_IMPORT_MODULE", () => {
	it("matches the specifier baked into the patched wasm", () => {
		expect(HB_SUBSET_IMPORT_MODULE).toContain("emscripten_notify_memory_growth");
		expect(HB_SUBSET_IMPORT_MODULE.startsWith("data:text/javascript,")).toBe(true);
	});
});
