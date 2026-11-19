import { describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { EntityCipher, defineCipher } from "@ktb/crypto/cipher";
import { CryptoFormatError } from "@ktb/crypto";

import { Keyring } from "@ktb/crypto/keyring";
import {
	EntityCipherStubLive,
	KeyringStubLive,
	makePassthroughCipher,
	passthroughCipherDriver,
	stubKeyringDriver,
} from "./index.ts";

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
		const err = await c.encryptRow(spec, dek, { id: 1, sneaky: "x" }).then(
			() => {
				throw new Error("expected CryptoFormatError");
			},
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(CryptoFormatError);
		expect((err as Error).message).toContain("cipher spec patient");
		expect((err as Error).message).toContain('undeclared field "sneaky"');
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

describe("stub keyring (T-141)", () => {
	it("resolves a working ephemeral keyring through the layer", async () => {
		const runtime = ManagedRuntime.make(KeyringStubLive);
		const keys = await runtime.runPromise(
			Effect.flatMap(Keyring, (k) => Effect.promise(() => k.deviceKeys())),
		);
		expect(keys.wrapPublicKey).toBeTruthy();
		expect(keys.signPublicKey).toBeTruthy();
		await runtime.dispose();
	});

	it("is always eligible and provides the stub layer", () => {
		expect(stubKeyringDriver.id).toBe("keyring-stub");
		expect(stubKeyringDriver.port).toBe(Keyring.key);
		expect(stubKeyringDriver.when?.({})).toBe(true);
		expect(stubKeyringDriver.provides({})).toBe(KeyringStubLive);
	});

	it("never touches IndexedDB — the store is memory even when indexedDB exists", async () => {
		const openCalls: string[] = [];
		vi.stubGlobal("indexedDB", {
			open: (name: string) => {
				openCalls.push(name);
				throw new Error("indexedDB must not be touched by the stub keyring");
			},
		});
		vi.resetModules();
		try {
			const [mod, { Keyring: FreshKeyring }, Effect, ManagedRuntime] = await Promise.all([
				import("./index.ts"),
				import("@ktb/crypto/keyring"),
				import("effect/Effect"),
				import("effect/ManagedRuntime"),
			]);
			const runtime = ManagedRuntime.make(mod.KeyringStubLive);
			await runtime.runPromise(
				Effect.flatMap(FreshKeyring, (k) =>
					Effect.promise(async () => {
						const keys = await k.deviceKeys();
						expect(keys.wrapPublicKey).toBeTruthy();
						await k.getSecret("absent");
					}),
				),
			);
			await runtime.dispose();
		} finally {
			vi.unstubAllGlobals();
			vi.resetModules();
		}
		expect(openCalls).toEqual([]);
	});
});
