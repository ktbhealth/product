/**
 * HarfBuzz font subsetting for the catalog-font pipeline, backed by a
 * vendored WASM build (`hb-subset.wasm`, see ../hb-subset/ for
 * provenance and the import-specifier patch).
 *
 * The module is a trimmed HarfBuzz `hb-subset` compiled to a
 * standalone wasm32 reactor (upstream: `hb-subset-wasm` on npm,
 * MIT — THIRD_PARTY_NOTICES in ../hb-subset). It accepts bare sfnt
 * fonts (TTF/OTF) only — the build ships without zlib/Brotli, so WOFF
 * and WOFF2 containers are unpacked/rejected by the caller
 * (font-subset.ts) before reaching this wrapper.
 *
 * Module shapes mirror brotli-dec.ts: Vite/Vitest/dev:node hand us an
 * already-instantiated exports namespace (Node's wasm-ESM integration),
 * while the Cloudflare worker build emits a `WebAssembly.Module`
 * (CompiledWasm binding) that we instantiate once with the import
 * stubs the module declares. workerd forbids runtime compilation of
 * raw bytes, so the `.wasm` import is the only portable path.
 */

import * as hbWasmModule from "./hb-subset.wasm";

/**
 * Import module specifier baked into the patched wasm's import
 * section (see hb-subset/patch-wasm.mjs). The module's single import
 * is the no-op `emscripten_notify_memory_growth` stub; under Node's
 * wasm-ESM the `data:` URL resolves to an inline JS module, and under
 * workerd we supply the same export through the imports object.
 */
export const HB_SUBSET_IMPORT_MODULE =
	"data:text/javascript,export%20function%20emscripten_notify_memory_growth(){}";

/** hb-subset flag bits (hb-subset.h). */
const HB_SUBSET_FLAGS_NO_HINTING = 0x00000001;
const HB_SUBSET_FLAGS_NOTDEF_OUTLINE = 0x00000040;

/** Exported surface the wrapper needs (wasm i32 params map to numbers). */
export interface HbSubsetExports {
	readonly memory: WebAssembly.Memory;
	readonly malloc: (n: number) => number;
	readonly free: (p: number) => void;
	readonly hb_wrapper_subset: (...args: readonly number[]) => number;
	readonly hb_wrapper_free: (p: number) => void;
	/** STANDALONE_WASM reactor init — exported by our build; run once. */
	readonly _initialize: () => void;
}

interface HbWasmExportsRecord {
	readonly memory?: unknown;
	readonly malloc?: unknown;
	readonly free?: unknown;
	readonly hb_wrapper_subset?: unknown;
	readonly hb_wrapper_free?: unknown;
	readonly default?: unknown;
}

const isExports = (rec: HbWasmExportsRecord): rec is HbWasmExportsRecord & HbSubsetExports =>
	typeof rec.hb_wrapper_subset === "function" &&
	typeof rec.malloc === "function" &&
	typeof rec.free === "function" &&
	typeof rec.hb_wrapper_free === "function" &&
	rec.memory instanceof WebAssembly.Memory;

/**
 * Normalize the two module shapes a `.wasm` import can take. Exported
 * for tests — both branches are exercised there.
 */
export const resolveHbSubsetModule = (ns: unknown): HbSubsetExports => {
	const rec = (ns ?? {}) as HbWasmExportsRecord;
	if (isExports(rec)) {
		// Vite/Vitest/dev:node: Node's wasm-ESM integration hands back the
		// instantiated exports namespace.
		return rec;
	}
	if (rec.default instanceof WebAssembly.Module) {
		// Cloudflare worker build: CompiledWasm binding → instantiate the
		// pre-compiled module (allowed; only runtime compilation of raw
		// bytes is not). The patched import section names our data: URL —
		// supply the matching stub here.
		const instance = new WebAssembly.Instance(rec.default, {
			[HB_SUBSET_IMPORT_MODULE]: {
				// v8 ignore next -- only invoked if the wasm grows memory
				emscripten_notify_memory_growth: () => {},
			},
		});
		return instance.exports as unknown as HbSubsetExports;
	}
	throw new Error("unsupported hb-subset module");
};

let exports_: HbSubsetExports | null = null;

const getExports = (): HbSubsetExports => {
	if (exports_ === null) {
		exports_ = resolveHbSubsetModule(hbWasmModule);
		// STANDALONE_WASM reactors need `_initialize` run once — the wasm
		// ESM integration does not call it and neither does our manual
		// Instance() above.
		exports_._initialize();
	}
	return exports_;
};

const MAX_UNICODES = 0x110000;

/**
 * Subset a bare sfnt font (TTF or CFF OpenType) to the given Unicode
 * codepoints. Returns the subset font bytes, or null on any failure —
 * corrupt input, unsupported flavor, wasm error or empty result all
 * degrade to "keep the full font" upstream. `ex` is injectable for
 * tests; production callers omit it.
 *
 * Flags: keep the .notdef outline and drop hinting — web fonts are
 * rasterized by the browser's own hinter, so fpgm/prep/cvt/glyf
 * instructions are dead weight (same trade-off Google Fonts makes).
 */
export const subsetFontBytes = (
	fontData: Uint8Array,
	unicodes: readonly number[],
	ex: HbSubsetExports = getExports(),
): Uint8Array | null => {
	try {
		if (fontData.byteLength === 0 || unicodes.length === 0) return null;
		if (unicodes.length > MAX_UNICODES) return null;
		for (const cp of unicodes) {
			if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return null;
		}
		const allocations: number[] = [];
		const walloc = (n: number): number => {
			const p = ex.malloc(n);
			if (p === 0) throw new Error("hb-subset malloc failed");
			allocations.push(p);
			return p;
		};
		try {
			const fontPtr = walloc(fontData.byteLength);
			// malloc may grow memory — take the view after allocating.
			new Uint8Array(ex.memory.buffer, fontPtr, fontData.byteLength).set(fontData);
			const uniPtr = walloc(unicodes.length * 4);
			new Uint32Array(ex.memory.buffer, uniPtr, unicodes.length).set(unicodes);
			const outDataPtrPtr = walloc(4);
			const outSizePtr = walloc(4);
			const flags = HB_SUBSET_FLAGS_NOTDEF_OUTLINE | HB_SUBSET_FLAGS_NO_HINTING;
			// hb_wrapper_subset(font, fontLen, unicodes, nUnicodes,
			//   glyphIds, nGlyphIds, flags, passthroughTags, nPass,
			//   dropTables, nDrop, pinTags, pinValues, nPin,
			//   rangeTags, rangeMins, rangeMaxs, rangeDefs, nRange,
			//   layoutFeatures, nFeatures, featuresAll,
			//   outDataPtrPtr, outSizePtr)
			const result = ex.hb_wrapper_subset(
				fontPtr,
				fontData.byteLength,
				uniPtr,
				unicodes.length,
				0,
				0,
				flags,
				// passthrough/drop/pin/range/layoutFeatures — all empty (15 args).
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				outDataPtrPtr,
				outSizePtr,
			);
			if (result !== 0) return null;
			// The subset call may have grown memory — re-read the buffer.
			const view = new DataView(ex.memory.buffer);
			const outDataPtr = view.getUint32(outDataPtrPtr, true);
			const outSize = view.getUint32(outSizePtr, true);
			if (outDataPtr === 0 || outSize === 0) return null;
			const output = new Uint8Array(outSize);
			output.set(new Uint8Array(ex.memory.buffer, outDataPtr, outSize));
			ex.hb_wrapper_free(outDataPtr);
			return output;
		} finally {
			for (const p of allocations) ex.free(p);
		}
	} catch {
		return null;
	}
};
