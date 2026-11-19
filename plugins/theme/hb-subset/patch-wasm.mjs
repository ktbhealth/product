#!/usr/bin/env bun
/**
 * patch-wasm.mjs — produce src/hb-subset.wasm from the upstream
 * `hb-subset-wasm` package binary.
 *
 * Upstream: https://github.com/kyosuke/hb-subset-wasm (MIT, see
 * THIRD_PARTY_NOTICES — bundles HarfBuzz). The npm artifact is
 * `hb-subset-wasm@0.5.0` → `dist/hb-subset.wasm`.
 *
 * Why patch: the module imports exactly one function,
 * `env.emscripten_notify_memory_growth` (a no-op memory-growth
 * notification stub). Node's WebAssembly-ESM integration — which is
 * what vitest / `dev:node` use for `.wasm` imports — resolves wasm
 * imports as ES module specifiers, so the bare module name `env`
 * fails with "Cannot find package 'env'". Rewriting the import
 * section's module string to a `data:` URL makes the import
 * self-contained: Node instantiates it against an inline JS module
 * exporting the stub, while the workerd path instantiates the
 * CompiledWasm `WebAssembly.Module` ourselves with an equivalent
 * import object (see src/hb-subset.ts).
 *
 * Usage:
 *   bun hb-subset/patch-wasm.mjs <input.wasm> <output.wasm>
 *
 * Fetch the input with: `npm pack hb-subset-wasm@0.5.0` then extract
 * `package/dist/hb-subset.wasm`.
 */

import { readFileSync, writeFileSync } from "node:fs";

/** Must match HB_SUBSET_IMPORT_MODULE in src/hb-subset.ts. */
const IMPORT_MODULE =
	"data:text/javascript,export%20function%20emscripten_notify_memory_growth(){}";
const IMPORT_FIELD = "emscripten_notify_memory_growth";
const FUNC_TYPE_INDEX = 2; // () -> () — verified against the 0.5.0 binary

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
	console.error("usage: bun hb-subset/patch-wasm.mjs <input.wasm> <output.wasm>");
	process.exit(1);
}

const bytes = readFileSync(input);

const uleb = (n) => {
	const out = [];
	for (;;) {
		const b = n & 0x7f;
		n >>>= 7;
		if (n !== 0) out.push(b | 0x80);
		else {
			out.push(b);
			break;
		}
	}
	return out;
};

// Walk sections; locate the import section (id 2) and verify it holds
// exactly the single expected import before rewriting it.
let pos = 8;
const sections = [];
while (pos < bytes.length) {
	const start = pos;
	const id = bytes[pos++];
	let size = 0;
	let shift = 0;
	for (;;) {
		const b = bytes[pos++];
		size |= (b & 0x7f) << shift;
		shift += 7;
		if ((b & 0x80) === 0) break;
	}
	sections.push({ id, start, bodyStart: pos, size });
	pos += size;
}

const imp = sections.find((s) => s.id === 2);
if (imp === undefined) throw new Error("no import section");

// Parse the single import entry: count(1), mod, field, kind=0, typeidx.
let p = imp.bodyStart;
const readUleb = () => {
	let v = 0;
	let s = 0;
	for (;;) {
		const b = bytes[p++];
		v |= (b & 0x7f) << s;
		s += 7;
		if ((b & 0x80) === 0) return v;
	}
};
const count = readUleb();
if (count !== 1) throw new Error(`expected 1 import, found ${count}`);
const modLen = readUleb();
const mod = bytes.subarray(p, p + modLen).toString("latin1");
p += modLen;
const fieldLen = readUleb();
const field = bytes.subarray(p, p + fieldLen).toString("latin1");
p += fieldLen;
const kind = bytes[p++];
const typeIndex = readUleb();
if (mod !== "env" || field !== IMPORT_FIELD || kind !== 0 || typeIndex !== FUNC_TYPE_INDEX) {
	throw new Error(
		`unexpected import ${mod}.${field} kind=${kind} type=${typeIndex} — re-verify FUNC_TYPE_INDEX`,
	);
}

// Rebuild the import section with the data: URL module specifier.
const spec = Buffer.from(IMPORT_MODULE, "latin1");
const fieldBytes = Buffer.from(IMPORT_FIELD, "latin1");
const entry = Buffer.concat([
	Buffer.from(uleb(spec.length)),
	spec,
	Buffer.from(uleb(fieldBytes.length)),
	fieldBytes,
	Buffer.from([0x00]), // func import
	Buffer.from(uleb(FUNC_TYPE_INDEX)),
]);
const body = Buffer.concat([Buffer.from(uleb(1)), entry]);
const newSection = Buffer.concat([Buffer.from([2]), Buffer.from(uleb(body.length)), body]);

// Sections are contiguous from offset 8 — splice the rewritten import
// section in place, preserving order.
const ordered = sections.map((s) =>
	s.id === 2 ? newSection : bytes.subarray(s.start, s.bodyStart + s.size),
);
const result = Buffer.concat([bytes.subarray(0, 8), ...ordered]);
writeFileSync(output, result);
console.log(`patched ${input} → ${output} (${bytes.length} → ${result.length} bytes)`);
