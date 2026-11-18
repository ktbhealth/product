import { describe, expect, it } from "vitest";

import { b64uToBytes, bytesToB64u, CryptoFormatError } from "./encoding.ts";
import {
	exportSignPrivateKey,
	exportSignPublicKey,
	generateSignKeyPair,
	importSignPrivateKey,
	importSignPublicKey,
	sign,
	verify,
} from "./sign.ts";

const encoder = new TextEncoder();

describe("ECDSA P-256 signatures", () => {
	it("signs and verifies a string", async () => {
		const pair = await generateSignKeyPair();
		const signature = await sign(pair.privateKey, "content-hash:abc123");
		expect(await verify(pair.publicKey, "content-hash:abc123", signature)).toBe(true);
	});

	it("signs and verifies raw bytes", async () => {
		const pair = await generateSignKeyPair();
		const data = encoder.encode("hash bytes");
		const signature = await sign(pair.privateKey, data);
		expect(await verify(pair.publicKey, data, signature)).toBe(true);
	});

	it("emits the raw r||s form (64 bytes)", async () => {
		const pair = await generateSignKeyPair();
		const signature = await sign(pair.privateKey, "data");
		expect(b64uToBytes(signature).length).toBe(64);
	});

	it("rejects data signed by a different key", async () => {
		const a = await generateSignKeyPair();
		const b = await generateSignKeyPair();
		const signature = await sign(a.privateKey, "doc");
		expect(await verify(b.publicKey, "doc", signature)).toBe(false);
	});

	it("rejects tampered data", async () => {
		const pair = await generateSignKeyPair();
		const signature = await sign(pair.privateKey, "original");
		expect(await verify(pair.publicKey, "tampered", signature)).toBe(false);
	});

	it("rejects a corrupted signature", async () => {
		const pair = await generateSignKeyPair();
		const signature = await sign(pair.privateKey, "doc");
		const bytes = b64uToBytes(signature);
		bytes[0] = bytes[0]! ^ 0xff;
		// A corrupted (r||s) pair verifies false or, if the mutation made
		// the encoding invalid for the verifier, throws — both are rejections.
		let result: boolean;
		try {
			result = await verify(pair.publicKey, "doc", bytesToB64u(bytes));
		} catch {
			result = false;
		}
		expect(result).toBe(false);
	});
});

describe("sign key import/export", () => {
	it("round-trips the pair through export/import", async () => {
		const pair = await generateSignKeyPair();
		const pub = await exportSignPublicKey(pair.publicKey);
		const priv = await exportSignPrivateKey(pair.privateKey);

		const importedPriv = await importSignPrivateKey(priv);
		const importedPub = await importSignPublicKey(pub);
		expect(importedPriv.extractable).toBe(true);
		expect(importedPub.extractable).toBe(true);
		const signature = await sign(importedPriv, "doc");
		expect(await verify(importedPub, "doc", signature)).toBe(true);
		// And the original public key verifies the re-imported signature.
		expect(await verify(pair.publicKey, "doc", signature)).toBe(true);
	});

	it("rejects invalid base64url key material synchronously", () => {
		expect(() => importSignPublicKey("!!!")).toThrow(CryptoFormatError);
		expect(() => importSignPrivateKey("!!!")).toThrow(CryptoFormatError);
	});
});
