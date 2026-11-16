// GENERATED FILE — do not edit.
// Regenerate with `bun run gen:cipher-specs` (tools/gen-cipher-specs.mjs).
// Aggregates plugin-owned declarative cipher specs (PL-007 F2): each
// plugins/<pkg>/src/cipher.ts exports defineCipher(...) spec(s); the
// flattened map below keys them by spec.entity for the EntityCipher
// impls that resolve a row's spec at runtime.
import type { CipherSpec } from "@ktb/crypto/cipher";

const modules: readonly Record<string, unknown>[] = [];

const isSpec = (value: unknown): value is CipherSpec =>
	typeof value === "object" &&
	value !== null &&
	"entity" in value &&
	"fields" in value &&
	"plaintext" in value;

/** Every declared spec, keyed by spec.entity. */
export const cipherSpecs: Readonly<Record<string, CipherSpec>> = Object.fromEntries(
	modules.flatMap((m) => Object.values(m).filter(isSpec)).map((spec) => [spec.entity, spec]),
);
