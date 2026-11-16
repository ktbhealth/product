#!/usr/bin/env bun
/**
 * Generates packages/app-host/src/cipher-specs.gen.ts — the aggregated
 * declarative cipher-spec entry point. Entity plugins declare their
 * field classes in plugins/<pkg>/src/cipher.ts via `defineCipher(...)`
 * (PL-007 F2, T-140); this script imports them by RELATIVE path —
 * same mechanism as tools/gen-db-schema.mjs, so @ktb/app-host never
 * gains a package.json dependency edge on plugin packages.
 *
 * A plugin cipher module is included only when it actually calls
 * `defineCipher(` — re-export shims and non-spec modules are skipped.
 *
 * Run after adding/moving a plugin cipher module:
 *
 *   bun run gen:cipher-specs
 *
 * Generated files are never hand-edited.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginsDir = join(root, "plugins");
const outPath = join(root, "packages/app-host/src/cipher-specs.gen.ts");

// Matches a spec declaration call: defineCipher({ ... }).
const SPEC_DECL_RE = /\bdefineCipher\s*\(/;

const owners = readdirSync(pluginsDir, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name)
	.sort()
	.filter((name) => {
		try {
			return SPEC_DECL_RE.test(readFileSync(join(pluginsDir, name, "src/cipher.ts"), "utf8"));
		} catch {
			return false;
		}
	});

const lines = [
	"// GENERATED FILE — do not edit.",
	"// Regenerate with `bun run gen:cipher-specs` (tools/gen-cipher-specs.mjs).",
	"// Aggregates plugin-owned declarative cipher specs (PL-007 F2): each",
	"// plugins/<pkg>/src/cipher.ts exports defineCipher(...) spec(s); the",
	"// flattened map below keys them by spec.entity for the EntityCipher",
	"// impls that resolve a row's spec at runtime.",
	'import type { CipherSpec } from "@ktb/crypto/cipher";',
	"",
	...owners.map((name, i) => `import * as _${i} from "../../../plugins/${name}/src/cipher.ts";`),
	// A blank separates the namespace imports from the module list only
	// when imports exist — otherwise the formatter collapses the pair.
	...(owners.length > 0 ? [""] : []),
	`const modules: readonly Record<string, unknown>[] = [${owners.map((_, i) => `_${i}`).join(", ")}];`,
	"",
	"const isSpec = (value: unknown): value is CipherSpec =>",
	'\ttypeof value === "object" &&',
	"\tvalue !== null &&",
	'\t"entity" in value &&',
	'\t"fields" in value &&',
	'\t"plaintext" in value;',
	"",
	"/** Every declared spec, keyed by spec.entity. */",
	"export const cipherSpecs: Readonly<Record<string, CipherSpec>> = Object.fromEntries(",
	"\tmodules.flatMap((m) => Object.values(m).filter(isSpec)).map((spec) => [spec.entity, spec]),",
	");",
	"",
];

writeFileSync(outPath, lines.join("\n"));
console.log(
	`gen-cipher-specs: wrote ${outPath} (${owners.length} plugin cipher module(s): ${owners.join(", ") || "none"})`,
);
