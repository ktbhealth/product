import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { generateDek } from "./aead.ts";
import {
	defineCipher,
	decryptRow,
	encryptPatch,
	encryptRow,
	EntityCipher,
	type CipherSpec,
} from "./cipher.ts";
import { CryptoFormatError } from "./encoding.ts";

const spec = defineCipher({
	entity: "consultation",
	fields: ["transcript", "anamnesis"],
	plaintext: ["id", "userId", "status", "createdAt"],
});

describe("defineCipher", () => {
	it("returns a valid spec verbatim", () => {
		expect(spec.entity).toBe("consultation");
		expect(spec.fields).toEqual(["transcript", "anamnesis"]);
	});

	it("rejects an empty entity name", () => {
		expect(() => defineCipher({ entity: "  ", fields: [], plaintext: ["id"] })).toThrow(
			CryptoFormatError,
		);
		expect(() => defineCipher({ entity: "", fields: [], plaintext: ["id"] })).toThrow(
			CryptoFormatError,
		);
		expect(() =>
			defineCipher({ entity: null as unknown as string, fields: [], plaintext: [] }),
		).toThrow(CryptoFormatError);
	});

	it("rejects duplicate field names", () => {
		expect(() => defineCipher({ entity: "e", fields: ["a", "a"], plaintext: [] })).toThrow(
			CryptoFormatError,
		);
		expect(() => defineCipher({ entity: "e", fields: [], plaintext: ["a", "a"] })).toThrow(
			CryptoFormatError,
		);
	});

	it("rejects a field declared both ciphered and plaintext", () => {
		expect(() => defineCipher({ entity: "e", fields: ["secret"], plaintext: ["secret"] })).toThrow(
			CryptoFormatError,
		);
	});
});

describe("encryptRow / decryptRow", () => {
	it("round-trips declared fields and leaves plaintext untouched", async () => {
		const dek = await generateDek();
		const row = {
			id: 1,
			userId: "u1",
			status: "done",
			createdAt: new Date(0),
			transcript: "hello",
			anamnesis: '{"a":1}',
		};
		const enc = await encryptRow(spec, dek, row);
		expect(enc.id).toBe(1);
		expect(enc.status).toBe("done");
		expect(enc.transcript).toMatch(/^v1\./);
		expect(enc.anamnesis).toMatch(/^v1\./);
		expect(enc.transcript).not.toBe("hello");

		const dec = await decryptRow(spec, dek, enc);
		expect(dec).toEqual(row);
	});

	it("serializes non-string field values canonically before encrypting", async () => {
		const dek = await generateDek();
		const enc = await encryptRow(spec, dek, {
			anamnesis: { b: 2, a: 1 },
			id: 1,
		});
		const dec = await decryptRow(spec, dek, enc);
		// Decrypt returns the canonical JSON text — key order stable.
		expect(dec.anamnesis).toBe('{"a":1,"b":2}');
	});

	it("keeps null and undefined cipher fields null", async () => {
		const dek = await generateDek();
		const enc = await encryptRow(spec, dek, {
			id: 1,
			transcript: null,
			anamnesis: undefined,
		});
		expect(enc.transcript).toBeNull();
		expect(enc.anamnesis).toBeNull();
		expect(await decryptRow(spec, dek, enc)).toEqual({
			id: 1,
			transcript: null,
			anamnesis: null,
		});
	});

	it("skips cipher fields absent from the row", async () => {
		const dek = await generateDek();
		const enc = await encryptRow(spec, dek, { id: 1 });
		expect("transcript" in enc).toBe(false);
	});

	it("rejects undeclared keys (fail closed)", async () => {
		const dek = await generateDek();
		await expect(encryptRow(spec, dek, { id: 1, sneaky: "x" })).rejects.toThrow(CryptoFormatError);
		await expect(decryptRow(spec, dek, { id: 1, sneaky: "x" })).rejects.toThrow(CryptoFormatError);
	});

	it("fails decryption with the wrong DEK", async () => {
		const dek = await generateDek();
		const other = await generateDek();
		const enc = await encryptRow(spec, dek, { id: 1, transcript: "t" });
		await expect(decryptRow(spec, other, enc)).rejects.toThrow();
	});

	it("rejects a non-envelope ciphered value on decrypt", async () => {
		const dek = await generateDek();
		await expect(
			decryptRow(spec, dek, { id: 1, transcript: "plaintext-not-envelope" }),
		).rejects.toThrow(CryptoFormatError);
		await expect(
			decryptRow(spec, dek, { id: 1, transcript: 42 as unknown as string }),
		).rejects.toThrow(CryptoFormatError);
	});
});

describe("encryptPatch", () => {
	it("encrypts only the keys present in the patch", async () => {
		const dek = await generateDek();
		const patch = await encryptPatch(spec, dek, { status: "done", transcript: "new" });
		expect(patch.status).toBe("done");
		expect(patch.transcript).toMatch(/^v1\./);
		expect("anamnesis" in patch).toBe(false);
	});

	it("rejects undeclared patch keys", async () => {
		const dek = await generateDek();
		await expect(encryptPatch(spec, dek, { nope: 1 })).rejects.toThrow(CryptoFormatError);
	});
});

describe("EntityCipher port", () => {
	it("is a Context service resolvable via serviceOption", async () => {
		const stub: CipherSpec = defineCipher({ entity: "e", fields: ["s"], plaintext: ["id"] });
		const passthrough = EntityCipher.of({
			encryptRow: async (_s, _d, row) => row,
			decryptRow: async (_s, _d, row) => row,
			encryptPatch: async (_s, _d, patch) => patch,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(EntityCipher, passthrough));
		const row = await runtime.runPromise(
			Effect.flatMap(EntityCipher, (c) =>
				Effect.promise(() => c.encryptRow(stub, null as unknown as CryptoKey, { id: 1, s: "x" })),
			),
		);
		expect(row.s).toBe("x");
		await runtime.dispose();
	});
});
