import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { brotliCompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { brotliInflate, resolveBrotliDecoder } from "./brotli-dec.ts";

const wasmBytes = readFileSync(fileURLToPath(new URL("./brotli-dec.wasm", import.meta.url)));

describe("resolveBrotliDecoder", () => {
	it("accepts an already-instantiated exports namespace", () => {
		const decoder = resolveBrotliDecoder({
			memory: new WebAssembly.Memory({ initial: 1 }),
			ktb_reserve: () => 0,
			ktb_brotli_decompress: () => -1,
			ktb_result_ptr: () => 0,
		});
		expect(decoder.decompress(0, 0, 0)).toBe(-1);
		expect(decoder.resultPtr()).toBe(0);
	});

	it("instantiates a WebAssembly.Module (worker CompiledWasm shape)", () => {
		const decoder = resolveBrotliDecoder({ default: new WebAssembly.Module(wasmBytes) });
		const payload = new TextEncoder().encode("module path works");
		const compressed = brotliCompressSync(payload);
		const inPtr = decoder.reserve(compressed.length);
		new Uint8Array(decoder.memory.buffer, inPtr, compressed.length).set(compressed);
		const len = decoder.decompress(inPtr, compressed.length, payload.length);
		expect(len).toBe(payload.length);
		expect(
			Buffer.from(new Uint8Array(decoder.memory.buffer, decoder.resultPtr(), len)).equals(
				Buffer.from(payload),
			),
		).toBe(true);
	});

	it("rejects unrecognized module shapes", () => {
		expect(() => resolveBrotliDecoder({})).toThrow("unsupported brotli decoder module");
		expect(() => resolveBrotliDecoder(null)).toThrow("unsupported brotli decoder module");
		expect(() => resolveBrotliDecoder("nope")).toThrow("unsupported brotli decoder module");
	});
});

describe("brotliInflate", () => {
	it("round-trips a brotli stream through the bundled wasm", () => {
		const payload = new TextEncoder().encode("woff2 metrics payload ".repeat(64));
		const out = brotliInflate(new Uint8Array(brotliCompressSync(payload)), payload.length);
		expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(payload));
	});

	it("throws on a corrupt stream so callers can return null", () => {
		expect(() => brotliInflate(new Uint8Array([1, 2, 3]), 16)).toThrow(
			"brotli decompression failed",
		);
	});
});
