/**
 * Ambient types for `.wasm` imports. Vite/Vitest serve the file as an
 * instantiated module namespace; Cloudflare worker builds emit it as a
 * `WebAssembly.Module` (CompiledWasm binding) instead — see
 * `resolveBrotliDecoder` in brotli-dec.ts for the runtime adaptation.
 */
declare module "*.wasm" {
	export const memory: WebAssembly.Memory;
	export function ktb_reserve(n: number): number;
	export function ktb_brotli_decompress(inPtr: number, inLen: number, outCap: number): number;
	export function ktb_result_ptr(): number;
}
