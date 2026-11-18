import { afterEach, describe, expect, it, vi } from "vitest";

import { Effect } from "effect";
import type * as Layer from "effect/Layer";

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
// Standard base64 (not base64url) containing both "+" and "/" — exercises
// the alphabet translation in decodeMasterKey.
const KEY_B64_STD = "+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/+/8=";
const KEY_B64_STD_BYTES = new Uint8Array(
	Array.from({ length: 32 }, (_, i) => [0xfb, 0xff, 0xbf][i % 3]!),
);

const dek = () => aead.generateDek().then(aead.exportDek);

const syncError = (fn: () => unknown): SecretKeyringError => {
	try {
		fn();
	} catch (e) {
		return e as SecretKeyringError;
	}
	throw new Error("expected function to throw");
};

const asyncError = async (p: Promise<unknown>): Promise<SecretKeyringError> => {
	try {
		await p;
	} catch (e) {
		return e as SecretKeyringError;
	}
	throw new Error("expected promise to reject");
};

describe("decodeMasterKey", () => {
	it("decodes base64, base64url and hex to 32 bytes", () => {
		expect(decodeMasterKey(KEY_B64)).toHaveLength(32);
		expect(decodeMasterKey(KEY_HEX)).toHaveLength(32);
		expect(decodeMasterKey(`  ${KEY_B64}\n`)).toHaveLength(32);
	});
	it("translates the standard base64 alphabet (+ and /) before decoding", () => {
		expect(decodeMasterKey(KEY_B64_STD)).toEqual(KEY_B64_STD_BYTES);
	});
	it("requires the hex form to match the whole string", () => {
		// 64 hex chars plus one extra char must not be read as hex.
		expect(() => decodeMasterKey(`!${KEY_HEX}`)).toThrow(SecretKeyringError);
		expect(() => decodeMasterKey(`${KEY_HEX}!`)).toThrow(SecretKeyringError);
	});
	it("strips only trailing padding, not interior '=' characters", () => {
		expect(decodeMasterKey("QQ==")).toEqual(new Uint8Array([0x41]));
		expect(() => decodeMasterKey("TQ==TQ==")).toThrow(SecretKeyringError);
		// Interior padding with no trailing run: stripping the first "="
		// group would leave a decodable string — the decoder must reject.
		expect(() => decodeMasterKey("AB==CD")).toThrow(SecretKeyringError);
	});
	it("rejects wrong-length and garbage input", () => {
		const wrongLength = syncError(() => decodeMasterKey("short"));
		expect(wrongLength).toBeInstanceOf(SecretKeyringError);
		expect(wrongLength.reason).toBe("malformed");
		expect(wrongLength.message).toMatch(/not hex\/base64 32-byte key material/);
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
		const badDek = await asyncError(kr.wrapDek(new Uint8Array(16)));
		expect(badDek).toBeInstanceOf(SecretKeyringError);
		expect(badDek.reason).toBe("malformed");
		expect(badDek.message).toBe("DEK must be 32 bytes, got 16");
		await expect(kr.unwrapDek("garbage")).rejects.toThrow(SecretKeyringError);
	});
	it("keys from different master keys cannot unwrap each other", async () => {
		const a = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		const b = await makeSecretKeyring(decodeMasterKey(KEY_HEX));
		const wrapped = await a.wrapDek(await dek());
		await expect(b.unwrapDek(wrapped)).rejects.toThrow(SecretKeyringError);
	});
	it("rejects a wrong-length master key", async () => {
		const err = await asyncError(makeSecretKeyring(new Uint8Array(16)));
		expect(err).toBeInstanceOf(SecretKeyringError);
		expect(err.reason).toBe("malformed");
		expect(err.message).toBe("VAULT_MASTER_KEY must decode to 32 bytes, got 16");
	});
	it("wrapDek surfaces encrypt failures as unavailable", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		vi.spyOn(aead, "encrypt").mockRejectedValueOnce(new Error("subtle down"));
		const err = await asyncError(kr.wrapDek(await dek()));
		expect(err).toBeInstanceOf(SecretKeyringError);
		expect(err.reason).toBe("unavailable");
		expect(err.message).toMatch(/wrap failed: subtle down/);
		vi.spyOn(aead, "encrypt").mockRejectedValueOnce("not-an-error");
		await expect(kr.wrapDek(await dek())).rejects.toThrow(/wrap failed: not-an-error/);
	});
	it("unwrapDek rejects a wrong-length plaintext and decrypt failures", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		vi.spyOn(aead, "decrypt").mockResolvedValueOnce(new Uint8Array(16));
		const short = await asyncError(kr.unwrapDek("v1.aa.bb"));
		expect(short).toBeInstanceOf(SecretKeyringError);
		expect(short.reason).toBe("decrypt-failed");
		expect(short.message).toBe("unwrapped DEK is 16 bytes, expected 32");
		vi.spyOn(aead, "decrypt").mockRejectedValueOnce(new Error("tag mismatch"));
		const failed = await asyncError(kr.unwrapDek("v1.aa.bb"));
		expect(failed.reason).toBe("decrypt-failed");
		expect(failed.message).toMatch(/unwrap failed: tag mismatch/);
		vi.spyOn(aead, "decrypt").mockRejectedValueOnce(42);
		await expect(kr.unwrapDek("v1.aa.bb")).rejects.toThrow(/unwrap failed: 42/);
	});
	it("forwards aad to aead only when provided", async () => {
		const kr = await makeSecretKeyring(decodeMasterKey(KEY_B64));
		const raw = await dek();
		const encSpy = vi.spyOn(aead, "encrypt");
		const decSpy = vi.spyOn(aead, "decrypt");
		const wrapped = await kr.wrapDek(raw);
		expect(encSpy.mock.calls[0]?.[2]).toBeUndefined();
		await kr.unwrapDek(wrapped);
		expect(decSpy.mock.calls[0]?.[2]).toBeUndefined();
		const wrappedAad = await kr.wrapDek(raw, "vault-dek:platform:x");
		expect(encSpy.mock.calls[1]?.[2]).toEqual({ aad: "vault-dek:platform:x" });
		await kr.unwrapDek(wrappedAad, "vault-dek:platform:x");
		expect(decSpy.mock.calls[1]?.[2]).toEqual({ aad: "vault-dek:platform:x" });
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
		const unusable = await asyncError(
			Effect.runPromise(
				Effect.void.pipe(Effect.provide(secretKeyringLive(undefined as unknown as string))),
			),
		);
		expect(unusable).toBeInstanceOf(SecretKeyringError);
		expect(unusable.reason).toBe("malformed");
		expect(unusable.message).toMatch(/VAULT_MASTER_KEY unusable/);
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
		expect(vaultKeyringEnvDriver.id).toBe("vault-keyring-env");
		expect(vaultKeyringEnvDriver.when!({ VAULT_MASTER_KEY: KEY_B64 })).toBe(true);
		expect(vaultKeyringEnvDriver.when!({})).toBe(false);
		expect(vaultKeyringEnvDriver.when!({ VAULT_MASTER_KEY: "  " })).toBe(false);
	});
	const resolveKeyring = (env: Parameters<typeof vaultKeyringEnvDriver.provides>[0]) =>
		Effect.runPromise(
			Effect.gen(function* () {
				return yield* SecretKeyring;
			}).pipe(
				Effect.provide(
					vaultKeyringEnvDriver.provides(env) as Layer.Layer<SecretKeyring, never, never>,
				),
			),
		);
	it("provides a working SecretKeyring service when the key is bound", async () => {
		const svc = await resolveKeyring({ VAULT_MASTER_KEY: KEY_B64 });
		const raw = await dek();
		const wrapped = await svc.wrapDek(raw);
		expect([...(await svc.unwrapDek(wrapped))]).toEqual([...raw]);
	});
	it("provides no SecretKeyring when the key is absent, blank or non-string", async () => {
		for (const env of [
			{},
			{ VAULT_MASTER_KEY: "  " },
			{ VAULT_MASTER_KEY: 42 as unknown as string },
		]) {
			const err = await resolveKeyring(env).then(
				() => {
					throw new Error("expected SecretKeyring to be missing");
				},
				(e: unknown) => e,
			);
			// Layer.empty must leave the service unbound — a SecretKeyringError
			// here would mean the driver tried (and failed) to build a layer.
			expect(err).not.toBeInstanceOf(SecretKeyringError);
		}
	});
});
