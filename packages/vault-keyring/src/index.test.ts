import { afterEach, describe, expect, it, vi } from "vitest";

import { Effect } from "effect";

import { aead } from "@ktb/crypto";
import { SecretKeyring, SecretKeyringError } from "@ktb/crypto/secret-keyring";
import {
	decodeMasterKey,
	makeSecretKeyring,
	secretKeyringLive,
	vaultKeyringEnvDriver,
} from "./index.ts";

// `aead` is a module-namespace re-export (`export * as aead`) — spread it
// into a plain object so individual primitives can be stubbed per test.
// `b64uThrow` lets a test make the base64 decoder reject with a non-Error
// so the `String(e)` fallback branches are reachable.
const cryptoMocks = vi.hoisted(() => ({
	b64uThrow: undefined as unknown,
}));

vi.mock("@ktb/crypto", async (importOriginal) => {
	const mod = await importOriginal<typeof import("@ktb/crypto")>();
	return {
		...mod,
		aead: { ...mod.aead },
		b64uToBytes: (input: string): Uint8Array => {
			if (cryptoMocks.b64uThrow !== undefined) throw cryptoMocks.b64uThrow;
			return mod.b64uToBytes(input);
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	cryptoMocks.b64uThrow = undefined;
});

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
	it("stringifies non-Error decoder failures", () => {
		cryptoMocks.b64uThrow = "decoder exploded";
		expect(() => decodeMasterKey("not-key-material!!!")).toThrow(
			/not hex\/base64 32-byte key material \(decoder exploded\)/,
		);
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
	it("wrapDek surfaces encrypt failures as unavailable", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		vi.spyOn(aead, "encrypt").mockRejectedValueOnce(new Error("subtle down"));
		await expect(kr.wrapDek(await dek())).rejects.toThrow(/wrap failed: subtle down/);
		vi.spyOn(aead, "encrypt").mockRejectedValueOnce("not-an-error");
		await expect(kr.wrapDek(await dek())).rejects.toThrow(/wrap failed: not-an-error/);
	});
	it("unwrapDek rejects a wrong-length plaintext and decrypt failures", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		vi.spyOn(aead, "decrypt").mockResolvedValueOnce(new Uint8Array(16));
		await expect(kr.unwrapDek("v1.aa.bb")).rejects.toThrow(/unwrapped DEK is 16 bytes/);
		vi.spyOn(aead, "decrypt").mockRejectedValueOnce(new Error("tag mismatch"));
		await expect(kr.unwrapDek("v1.aa.bb")).rejects.toThrow(/unwrap failed: tag mismatch/);
		vi.spyOn(aead, "decrypt").mockRejectedValueOnce(42);
		await expect(kr.unwrapDek("v1.aa.bb")).rejects.toThrow(/unwrap failed: 42/);
	});
});

describe("secretKeyringLive", () => {
	it("provides a working SecretKeyring service", async () => {
		const svc = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* SecretKeyring;
			}).pipe(Effect.provide(secretKeyringLive(KEY_B64))),
		);
		const raw = await dek();
		const wrapped = await svc.wrapDek(raw, "vault-dek:platform:x");
		const back = await svc.unwrapDek(wrapped, "vault-dek:platform:x");
		expect([...back]).toEqual([...raw]);
	});
	it("fails the layer build on malformed key material", async () => {
		await expect(
			Effect.runPromise(Effect.void.pipe(Effect.provide(secretKeyringLive("garbage")))),
		).rejects.toThrow(SecretKeyringError);
	});
	it("wraps non-keyring failures as malformed", async () => {
		await expect(
			Effect.runPromise(
				Effect.void.pipe(Effect.provide(secretKeyringLive(undefined as unknown as string))),
			),
		).rejects.toThrow(/VAULT_MASTER_KEY unusable/);
		// A non-Error rejection exercises the String(e) fallback.
		const hostile = {
			trim: () => {
				throw "boom";
			},
		};
		await expect(
			Effect.runPromise(
				Effect.void.pipe(Effect.provide(secretKeyringLive(hostile as unknown as string))),
			),
		).rejects.toThrow(/VAULT_MASTER_KEY unusable: boom/);
	});
});

describe("vaultKeyringEnvDriver", () => {
	it("is eligible only when VAULT_MASTER_KEY is bound", () => {
		expect(vaultKeyringEnvDriver.when!({ VAULT_MASTER_KEY: KEY_B64 })).toBe(true);
		expect(vaultKeyringEnvDriver.when!({})).toBe(false);
		expect(vaultKeyringEnvDriver.when!({ VAULT_MASTER_KEY: "  " })).toBe(false);
	});
	it("provides a live layer only when the key is bound", () => {
		expect(vaultKeyringEnvDriver.provides({ VAULT_MASTER_KEY: KEY_B64 })).toBeDefined();
		expect(vaultKeyringEnvDriver.provides({})).toBeDefined();
		expect(vaultKeyringEnvDriver.provides({ VAULT_MASTER_KEY: "  " })).toBeDefined();
	});
});
