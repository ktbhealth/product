import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { aead } from "@ktb/crypto";
import { SecretKeyring, SecretKeyringError } from "@ktb/crypto/secret-keyring";
import {
	decodeMasterKey,
	makeSecretKeyring,
	secretKeyringLive,
	vaultKeyringEnvDriver,
} from "./index.ts";

const KEY_B64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32 bytes b64
const KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const dek = () => aead.generateDek().then(aead.exportDek);

describe("decodeMasterKey", () => {
	it("decodes base64, base64url and hex to 32 bytes", () => {
		expect(decodeMasterKey(KEY_B64)).toHaveLength(32);
		expect(decodeMasterKey(KEY_HEX)).toHaveLength(32);
		expect(decodeMasterKey(`  ${KEY_B64}\n`)).toHaveLength(32);
	});
	it("rejects wrong-length and garbage input", () => {
		expect(() => decodeMasterKey("short")).toThrow(SecretKeyringError);
		expect(() => decodeMasterKey("not-key-material!!!")).toThrow(SecretKeyringError);
	});
});

describe("makeSecretKeyring", () => {
	it("wraps and unwraps a DEK, AAD-bound", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		const raw = await dek();
		const wrapped = await kr.wrapDek(raw, "vault-dek:platform:x");
		expect(wrapped.startsWith("v1.")).toBe(true);
		expect(kr.kekVersion).toMatch(/^env:[0-9a-f]{16}$/);
		const back = await kr.unwrapDek(wrapped, "vault-dek:platform:x");
		expect([...back]).toEqual([...raw]);
	});
	it("rejects unwrap under a different AAD", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		const wrapped = await kr.wrapDek(await dek(), "vault-dek:platform:a");
		await expect(kr.unwrapDek(wrapped, "vault-dek:platform:b")).rejects.toThrow(SecretKeyringError);
	});
	it("rejects non-32-byte DEKs and malformed envelopes", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		await expect(kr.wrapDek(new Uint8Array(16))).rejects.toThrow(SecretKeyringError);
		await expect(kr.unwrapDek("garbage")).rejects.toThrow(SecretKeyringError);
	});
	it("keys from different master keys cannot unwrap each other", async () => {
		const a = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		const b = await makeSecretKeyring(decodeMasterKey(KEY_HEX));
		const wrapped = await a.wrapDek(await dek());
		await expect(b.unwrapDek(wrapped)).rejects.toThrow(SecretKeyringError);
	});
	it("rejects a wrong-length master key", async () => {
		await expect(makeSecretKeyring(new Uint8Array(16))).rejects.toThrow(SecretKeyringError);
	});
	it("reports WebCrypto failures as 'unavailable'", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		// A 32-length non-Uint8Array slips past the length guard; WebCrypto
		// rejects the bogus BufferSource.
		const err = await kr.wrapDek({ length: 32 } as unknown as Uint8Array).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SecretKeyringError);
		expect((err as SecretKeyringError).reason).toBe("unavailable");
	});
	it("rejects envelopes that unwrap to a non-32-byte DEK", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		// Encrypt a 16-byte payload under the same KEK — decrypt succeeds
		// but the plaintext is not a valid DEK.
		const kek = await aead.importDek(decodeMasterKey(KEY_B64));
		const short = await aead.encrypt(kek, new Uint8Array(16));
		const err = await kr.unwrapDek(short).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SecretKeyringError);
		expect((err as SecretKeyringError).reason).toBe("decrypt-failed");
	});
});

describe("secretKeyringLive", () => {
	it("builds a working SecretKeyring layer", async () => {
		const kr = await Effect.runPromise(
			Effect.service(SecretKeyring).pipe(Effect.provide(secretKeyringLive(KEY_B64))),
		);
		const raw = await dek();
		const wrapped = await kr.wrapDek(raw, "vault-dek:platform:x");
		expect(await kr.unwrapDek(wrapped, "vault-dek:platform:x")).toEqual(raw);
		expect(kr.kekVersion).toMatch(/^env:[0-9a-f]{16}$/);
	});
	it("fails the layer build on malformed key material", async () => {
		await expect(
			Effect.runPromise(
				Effect.service(SecretKeyring).pipe(Effect.provide(secretKeyringLive("not-a-key"))),
			),
		).rejects.toThrow(SecretKeyringError);
	});
});

describe("vaultKeyringEnvDriver", () => {
	it("is eligible only when VAULT_MASTER_KEY is bound", () => {
		expect(vaultKeyringEnvDriver.when!({ VAULT_MASTER_KEY: KEY_B64 })).toBe(true);
		expect(vaultKeyringEnvDriver.when!({})).toBe(false);
		expect(vaultKeyringEnvDriver.when!({ VAULT_MASTER_KEY: "  " })).toBe(false);
	});
	it("provides() returns the live layer when the key is bound, empty otherwise", async () => {
		const kr = await Effect.runPromise(
			Effect.service(SecretKeyring).pipe(
				Effect.provide(
					vaultKeyringEnvDriver.provides({ VAULT_MASTER_KEY: KEY_B64 }) as Layer.Layer<
						SecretKeyring,
						never,
						never
					>,
				),
			),
		);
		expect(kr.kekVersion).toMatch(/^env:[0-9a-f]{16}$/);
		expect(vaultKeyringEnvDriver.provides({})).toBeDefined();
	});
});
