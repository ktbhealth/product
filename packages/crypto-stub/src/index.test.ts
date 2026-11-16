import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { EntityCipher, defineCipher } from "@ktb/crypto/cipher";
import { CryptoFormatError } from "@ktb/crypto";

import { EntityCipherStubLive, makePassthroughCipher, passthroughCipherDriver } from "./index.ts";

const spec = defineCipher({
	entity: "patient",
	fields: ["name", "phone"],
	plaintext: ["id", "ownerId"],
});

describe("passthrough EntityCipher", () => {
	it("returns rows verbatim — plaintext storage for non-ZK tenants", async () => {
		const c = makePassthroughCipher();
		const row = { id: 1, ownerId: "u1", name: "Maria", phone: null };
		const dek = null as unknown as CryptoKey;
		expect(await c.encryptRow(spec, dek, row)).toEqual(row);
		expect(await c.decryptRow(spec, dek, row)).toEqual(row);
		expect(await c.encryptPatch(spec, dek, { name: "Ana" })).toEqual({ name: "Ana" });
		// The returned row is a copy, not the input reference.
		expect(await c.encryptRow(spec, dek, row)).not.toBe(row);
	});

	it("still enforces the spec contract — undeclared keys throw", async () => {
		const c = makePassthroughCipher();
		const dek = null as unknown as CryptoKey;
		await expect(c.encryptRow(spec, dek, { id: 1, sneaky: "x" })).rejects.toThrow(
			CryptoFormatError,
		);
	});

	it("is bound through EntityCipherStubLive", async () => {
		const runtime = ManagedRuntime.make(EntityCipherStubLive);
		const row = await runtime.runPromise(
			Effect.flatMap(EntityCipher, (c) =>
				Effect.promise(() =>
					c.encryptRow(spec, null as unknown as CryptoKey, { id: 1, name: "x" }),
				),
			),
		);
		expect(row).toEqual({ id: 1, name: "x" });
		await runtime.dispose();
	});
});

describe("passthroughCipherDriver", () => {
	it("is always eligible (non-ZK default until vault drivers land)", () => {
		expect(passthroughCipherDriver.id).toBe("cipher-passthrough");
		expect(passthroughCipherDriver.port).toBe(EntityCipher.key);
		expect(passthroughCipherDriver.when?.({})).toBe(true);
		expect(passthroughCipherDriver.when?.({ CIPHER_STUB: "1" })).toBe(true);
	});

	it("provides the stub layer", () => {
		expect(passthroughCipherDriver.provides({})).toBe(EntityCipherStubLive);
	});
});
