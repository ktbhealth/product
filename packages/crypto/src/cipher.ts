import * as Context from "effect/Context";

import { decryptText, encrypt } from "./aead.ts";
import { canonicalize } from "./digest.ts";
import { CryptoFormatError } from "./encoding.ts";

/**
 * Declarative entity cipher spec (PL-007 F2): which fields of a record
 * are ciphertext at rest (`fields`) and which stay plaintext
 * (`plaintext` — the columns authz/metadata need: ids, owners, status,
 * timestamps). The contract is fail-closed: a key present on a row but
 * declared in NEITHER list throws `CryptoFormatError` instead of
 * silently persisting an unclassified field.
 *
 * Specs are module exports discovered by filesystem glob — each plugin
 * ships `plugins/<pkg>/src/cipher.ts` exporting its spec(s), aggregated
 * like `schema.ts` modules (no kernel change).
 */
export interface CipherSpec<F extends string = string> {
	/** Entity discriminator — "<domain>" matching the record's table. */
	readonly entity: string;
	/** Columns stored as `v1.<iv>.<ct>` AEAD envelopes. */
	readonly fields: readonly F[];
	/** Columns allowed to stay plaintext — everything else is rejected. */
	readonly plaintext: readonly F[];
}

/** Validate a spec at module scope: disjoint, duplicate-free lists and
 * a non-empty entity name. Throws `CryptoFormatError` on violations —
 * a bad spec must fail at import time, not mid-request. */
export const defineCipher = <F extends string>(spec: CipherSpec<F>): CipherSpec<F> => {
	if (typeof spec.entity !== "string" || spec.entity.trim() === "") {
		throw new CryptoFormatError("cipher spec entity must be a non-empty string");
	}
	const ciphered = new Set<string>(spec.fields);
	const plain = new Set<string>(spec.plaintext);
	if (ciphered.size !== spec.fields.length || plain.size !== spec.plaintext.length) {
		throw new CryptoFormatError(`cipher spec ${spec.entity}: duplicate field names`);
	}
	for (const field of spec.fields) {
		if (plain.has(field)) {
			throw new CryptoFormatError(
				`cipher spec ${spec.entity}: field "${field}" declared both ciphered and plaintext`,
			);
		}
	}
	return spec;
};

/** A row or patch as a plain key→value bag — drizzle rows and wire
 * payloads both fit; cipher ops never inspect declared-plaintext values. */
export type CipherRow = Record<string, unknown>;

const assertDeclared = (spec: CipherSpec, row: CipherRow): void => {
	for (const key of Object.keys(row)) {
		if (!spec.fields.includes(key) && !spec.plaintext.includes(key)) {
			throw new CryptoFormatError(
				`cipher spec ${spec.entity}: undeclared field "${key}" — every persisted key must be classified`,
			);
		}
	}
};

/** Encrypt one field value: strings pass as-is, other JSON-ables go
 * through canonical serialization (deterministic — the same value
 * re-encrypts to equivalent plaintext). null/undefined stay null so a
 * cleared column never mints ciphertext. */
const encodeField = async (dek: CryptoKey, value: unknown): Promise<string | null> => {
	if (value === null || value === undefined) return null;
	const text = typeof value === "string" ? value : canonicalize(value);
	return encrypt(dek, text);
};

/** Decrypt one field: null stays null; anything that is not a v1
 * envelope is tampered or non-ciphered data — fail loud. */
const decodeField = async (dek: CryptoKey, value: unknown): Promise<string | null> => {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") {
		throw new CryptoFormatError("ciphered field is not a string envelope");
	}
	return decryptText(dek, value);
};

/**
 * Encrypt a full row per `spec`: each `fields` key becomes an AEAD
 * envelope, `plaintext` keys pass through, undeclared keys throw.
 * The DEK comes from the caller — the codec never mints or stores keys.
 */
export const encryptRow = async (
	spec: CipherSpec,
	dek: CryptoKey,
	row: CipherRow,
): Promise<CipherRow> => {
	assertDeclared(spec, row);
	const out: CipherRow = { ...row };
	for (const field of spec.fields) {
		if (field in row) out[field] = await encodeField(dek, row[field]);
	}
	return out;
};

/** Decrypt a stored row: envelopes in `fields` become plaintext strings,
 * everything else passes through. Non-envelope ciphered values throw. */
export const decryptRow = async (
	spec: CipherSpec,
	dek: CryptoKey,
	row: CipherRow,
): Promise<CipherRow> => {
	assertDeclared(spec, row);
	const out: CipherRow = { ...row };
	for (const field of spec.fields) {
		if (field in row) out[field] = await decodeField(dek, row[field]);
	}
	return out;
};

/**
 * Encrypt a partial update (only the keys being written): same rules as
 * `encryptRow` scoped to the patch — an absent ciphered field simply is
 * not written, so updates cannot clobber columns they never touched.
 */
export const encryptPatch = async (
	spec: CipherSpec,
	dek: CryptoKey,
	patch: CipherRow,
): Promise<CipherRow> => encryptRow(spec, dek, patch);

/**
 * EntityCipher port (PL-007 F2, T-140): the row-level crypto boundary
 * every entity plugin writes through. Promise-shaped like the other
 * ports — impls live in sibling packages: `@ktb/crypto-stub` is the
 * non-ZK passthrough (rows persist plaintext exactly as today); the
 * real per-tenant DEK impl lands with the vault plugin (T-142+).
 *
 * Consumers resolve it via `Effect.serviceOption(EntityCipher)` —
 * non-ZK deployments may bind nothing and keep plaintext paths.
 */
export interface EntityCipherService {
	readonly encryptRow: (spec: CipherSpec, dek: CryptoKey, row: CipherRow) => Promise<CipherRow>;
	readonly decryptRow: (spec: CipherSpec, dek: CryptoKey, row: CipherRow) => Promise<CipherRow>;
	readonly encryptPatch: (spec: CipherSpec, dek: CryptoKey, patch: CipherRow) => Promise<CipherRow>;
}

export class EntityCipher extends Context.Service<EntityCipher, EntityCipherService>()(
	"@ktb/crypto/EntityCipher",
) {}

/** Env slice read by EntityCipher drivers (mirrors app-host AppEnv).
 * The stub is always eligible — it is the non-ZK default until real
 * DEK drivers arrive with the vault plugin. */
export interface CipherDriverEnv {
	readonly CIPHER_STUB?: unknown;
}
