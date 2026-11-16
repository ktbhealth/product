/**
 * Brotli decompression for the WOFF2 font path, backed by a purpose-built
 * zero-import WASM decoder (`brotli-dec.wasm`). The module was compiled
 * from the upstream Brotli 1.1.0 C decoder (`c/dec` + `c/common`) with
 * `clang --target=wasm32-unknown-unknown -O2 -ffreestanding -fno-builtin
 * -nostdlib` and `wasm-ld --export-memory`, plus a ~100-line wrapper
 * exposing `ktb_reserve` / `ktb_brotli_decompress` / `ktb_result_ptr`
 * over a bump-allocated, `memory.grow`-backed heap. It has no imports,
 * which is what lets Vite's wasm plugin and workerd's CompiledWasm
 * binding both consume it.
 *
 * Why WASM: workerd has no Brotli in `DecompressionStream` and the worker
 * deploy runs without `nodejs_compat`, so `node:zlib` is unavailable in
 * production. workerd also rejects runtime WASM compilation
 * (`WebAssembly.Module`/`instantiate` on raw bytes throw "Wasm code
 * generation disallowed by embedder"), so the decoder must ship as a
 * `.wasm` module import: Vite/Vitest (`dev:node`, tests) hand us the
 * instantiated exports, while the Cloudflare build emits a
 * `CompiledWasm` binding — a `WebAssembly.Module` we instantiate once.
 * Both shapes converge on the same four exports.
 */

import * as brotliWasmModule from "./brotli-dec.wasm";

/** The decoder's exported surface (wasm i32 params map to JS numbers). */
export interface BrotliDecoder {
	readonly memory: WebAssembly.Memory;
	/** Grow linear memory so `[returnedOffset, +n)` is writable. */
	readonly reserve: (n: number) => number;
	/**
	 * Decompress the brotli stream at `inPtr`/`inLen` (already written into
	 * `memory`). `outCap` is an upper bound hint — the decoder allocates
	 * `outCap` + slack. Returns the decompressed length, or -1 on error;
	 * output bytes live at `resultPtr()` in `memory`.
	 */
	readonly decompress: (inPtr: number, inLen: number, outCap: number) => number;
	readonly resultPtr: () => number;
}

/** Raw wasm export names, common to both module shapes. */
interface BrotliWasmExports {
	readonly memory: WebAssembly.Memory;
	readonly ktb_reserve: (n: number) => number;
	readonly ktb_brotli_decompress: (inPtr: number, inLen: number, outCap: number) => number;
	readonly ktb_result_ptr: () => number;
}

const wrap = (e: BrotliWasmExports): BrotliDecoder => ({
	memory: e.memory,
	reserve: e.ktb_reserve,
	decompress: e.ktb_brotli_decompress,
	resultPtr: e.ktb_result_ptr,
});

/**
 * Normalize the two module shapes a `.wasm` import can take. Exported
 * for tests — both branches are exercised there.
 */
export const resolveBrotliDecoder = (ns: unknown): BrotliDecoder => {
	const rec = (ns ?? {}) as Partial<BrotliWasmExports> & { default?: unknown };
	if (typeof rec.ktb_brotli_decompress === "function") {
		// Vite/Vitest: the wasm module's exports are the namespace itself.
		return wrap(rec as BrotliWasmExports);
	}
	if (rec.default instanceof WebAssembly.Module) {
		// Cloudflare worker build: CompiledWasm binding → instantiate the
		// pre-compiled module (allowed; only runtime compilation is not).
		return wrap(new WebAssembly.Instance(rec.default).exports as unknown as BrotliWasmExports);
	}
	throw new Error("unsupported brotli decoder module");
};

let decoder: BrotliDecoder | null = null;

const getDecoder = (): BrotliDecoder => (decoder ??= resolveBrotliDecoder(brotliWasmModule));

/**
 * One-shot Brotli decompress. `expectedSize` is the caller's known
 * decompressed length (the WOFF2 directory's total table bytes) — it
 * sizes the output buffer; a stream producing more is rejected upstream
 * by the size check in `woff2Metrics`.
 */
export const brotliInflate = (input: Uint8Array, expectedSize: number): Uint8Array => {
	const d = getDecoder();
	const inPtr = d.reserve(input.byteLength);
	// reserve() may grow memory — the buffer view must be taken after it.
	new Uint8Array(d.memory.buffer, inPtr, input.byteLength).set(input);
	const len = d.decompress(inPtr, input.byteLength, expectedSize);
	if (len < 0) throw new Error("brotli decompression failed");
	// The decoder's bump heap is reset per call, but the returned slice
	// must be a private copy — the next decompress would reuse the pages.
	return new Uint8Array(d.memory.buffer, d.resultPtr(), len).slice();
};
