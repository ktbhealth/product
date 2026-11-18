import { describe, expect, it } from "vitest";

import { decryptText, encrypt } from "./aead.ts";
import { bytesToHex } from "./encoding.ts";
import {
	generateSalt,
	hkdfBytes,
	hkdfToAesKey,
	PBKDF2_ITERATIONS,
	pbkdf2Bytes,
	pbkdf2ToAesKey,
	SALT_BYTES,
} from "./kdf.ts";

const encoder = new TextEncoder();

describe("pbkdf2Bytes", () => {
	it("matches the RFC 6070-style SHA-256 vector (c=1, dkLen=32)", async () => {
		// PBKDF2-HMAC-SHA256("password", "salt", 1, 32)
		const bits = await pbkdf2Bytes("password", encoder.encode("salt"), 1, 32);
		expect(bytesToHex(bits)).toBe(
			"120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
		);
	});

	it("matches the c=2 vector", async () => {
		const bits = await pbkdf2Bytes("password", encoder.encode("salt"), 2, 32);
		expect(bytesToHex(bits)).toBe(
			"ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43",
		);
	});

	it("is deterministic and salt-sensitive", async () => {
		const salt = encoder.encode("somesalt");
		const a = await pbkdf2Bytes("pass", salt, 100, 16);
		const b = await pbkdf2Bytes("pass", salt, 100, 16);
		const c = await pbkdf2Bytes("pass", encoder.encode("other"), 100, 16);
		expect(a).toEqual(b);
		expect(a).not.toEqual(c);
		expect(a.length).toBe(16);
	});
});

describe("pbkdf2ToAesKey", () => {
	it("derives a usable AES-256-GCM key", async () => {
		const salt = generateSalt();
		const key = await pbkdf2ToAesKey("correct horse", salt, 1000);
		expect(key.extractable).toBe(false);
		const envelope = await encrypt(key, "vault secret");
		expect(await decryptText(key, envelope)).toBe("vault secret");
	});

	it("derives different keys for different passphrases", async () => {
		const salt = generateSalt();
		const a = await pbkdf2ToAesKey("one", salt, 1000);
		const b = await pbkdf2ToAesKey("two", salt, 1000);
		const envelope = await encrypt(a, "x");
		await expect(decryptText(b, envelope)).rejects.toThrow();
	});

	it("defaults to the OWASP iteration floor", async () => {
		expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
		// One default-iteration derivation to cover the default parameter
		// (slow by design — this is the work factor).
		const key = await pbkdf2ToAesKey("pass", generateSalt());
		expect(key.algorithm).toEqual({ name: "AES-GCM", length: 256 });
	}, 60_000);
});

describe("generateSalt", () => {
	it("returns fresh random salts of the declared size", () => {
		const a = generateSalt();
		const b = generateSalt();
		expect(a.length).toBe(SALT_BYTES);
		expect(a).not.toEqual(b);
	});
});

describe("hkdfBytes", () => {
	it("is deterministic and info-bound", async () => {
		const ikm = crypto.getRandomValues(new Uint8Array(32));
		const salt = generateSalt();
		const a = await hkdfBytes(ikm, salt, "purpose.a", 32);
		const b = await hkdfBytes(ikm, salt, "purpose.a", 32);
		const c = await hkdfBytes(ikm, salt, "purpose.b", 32);
		expect(a).toEqual(b);
		expect(a).not.toEqual(c);
	});

	it("honors the requested length", async () => {
		const ikm = crypto.getRandomValues(new Uint8Array(32));
		expect((await hkdfBytes(ikm, new Uint8Array(0), "i", 16)).length).toBe(16);
	});
});

describe("hkdfToAesKey", () => {
	it("derives a key that round-trips AES-GCM", async () => {
		const ikm = crypto.getRandomValues(new Uint8Array(32));
		const salt = generateSalt();
		const key = await hkdfToAesKey(ikm, salt, "ktb.test");
		expect(key.extractable).toBe(true);
		const again = await hkdfToAesKey(ikm, salt, "ktb.test");
		const envelope = await encrypt(key, "data");
		expect(await decryptText(again, envelope)).toBe("data");
	});
});
