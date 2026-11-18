import { describe, expect, it } from "vitest";

import { decrypt, decryptText, encrypt, exportDek, generateDek, importDek } from "./aead.ts";
import { bytesToB64u, CryptoFormatError } from "./encoding.ts";

describe("AEAD (AES-256-GCM envelope)", () => {
	it("round-trips a string", async () => {
		const key = await generateDek();
		const envelope = await encrypt(key, "anamnese do paciente");
		expect(envelope.startsWith("v1.")).toBe(true);
		expect(await decryptText(key, envelope)).toBe("anamnese do paciente");
	});

	it("round-trips raw bytes", async () => {
		const key = await generateDek();
		const bytes = crypto.getRandomValues(new Uint8Array(512));
		const envelope = await encrypt(key, bytes);
		expect(await decrypt(key, envelope)).toEqual(bytes);
	});

	it("produces a fresh IV per message", async () => {
		const key = await generateDek();
		const a = await encrypt(key, "same");
		const b = await encrypt(key, "same");
		expect(a).not.toBe(b);
	});

	it("exports and re-imports a DEK", async () => {
		const key = await generateDek();
		const raw = await exportDek(key);
		expect(raw.length).toBe(32);
		const reimported = await importDek(raw);
		const envelope = await encrypt(key, "data");
		expect(await decryptText(reimported, envelope)).toBe("data");
	});

	it("imports with restricted usages", async () => {
		const key = await importDek(crypto.getRandomValues(new Uint8Array(32)), ["decrypt"]);
		await expect(encrypt(key, "x")).rejects.toThrow();
	});

	it("rejects a wrong key", async () => {
		const a = await generateDek();
		const b = await generateDek();
		const envelope = await encrypt(a, "secret");
		await expect(decrypt(b, envelope)).rejects.toThrow();
	});

	it("rejects tampered ciphertext", async () => {
		const key = await generateDek();
		const envelope = await encrypt(key, "secret");
		const [v, iv, ct] = envelope.split(".");
		// Flip a middle character — trailing chars can sit in unused pad
		// bits and decode to identical bytes (flaky otherwise).
		const mid = Math.floor(ct!.length / 2);
		const flipped = ct![mid] === "A" ? "B" : "A";
		const tampered = `${v}.${iv}.${ct!.slice(0, mid)}${flipped}${ct!.slice(mid + 1)}`;
		await expect(decrypt(key, tampered)).rejects.toThrow();
	});

	it("rejects malformed envelopes", async () => {
		const key = await generateDek();
		const envelope = await encrypt(key, "secret");
		const [, iv, ct] = envelope.split(".");
		await expect(decrypt(key, "not-an-envelope")).rejects.toThrow(CryptoFormatError);
		await expect(decrypt(key, "not-an-envelope")).rejects.toThrow(/not a v1 AEAD envelope/);
		await expect(decrypt(key, "v9.aaa.bbb")).rejects.toThrow(CryptoFormatError);
		// A structurally valid envelope under a foreign version must still
		// fail the version check — not slip through to a successful decrypt.
		await expect(decrypt(key, `v9.${iv}.${ct}`)).rejects.toThrow(CryptoFormatError);
		await expect(decrypt(key, "v1.too.few")).rejects.toThrow();
		await expect(decrypt(key, "v1.a.b.c.d")).rejects.toThrow(CryptoFormatError);
		// Extra trailing segments are malformed even when the v1 parts are valid.
		await expect(decrypt(key, `${envelope}.extra`)).rejects.toThrow(CryptoFormatError);
	});

	it("rejects a wrong-length IV", async () => {
		const key = await generateDek();
		const shortIv = bytesToB64u(new Uint8Array(4));
		const ct = bytesToB64u(new Uint8Array(32));
		await expect(decrypt(key, `v1.${shortIv}.${ct}`)).rejects.toThrow(CryptoFormatError);
		await expect(decrypt(key, `v1.${shortIv}.${ct}`)).rejects.toThrow(/bad IV length/);
	});

	it("binds aad into the tag — wrong or missing aad fails", async () => {
		const key = await generateDek();
		const envelope = await encrypt(key, "secret", { aad: "row:1" });
		expect(await decryptText(key, envelope, { aad: "row:1" })).toBe("secret");
		await expect(decrypt(key, envelope)).rejects.toThrow();
		await expect(decrypt(key, envelope, { aad: "row:2" })).rejects.toThrow();
		// Uint8Array aad form round-trips identically.
		const bytes = await encrypt(key, "secret", { aad: new Uint8Array([1, 2, 3]) });
		expect(await decryptText(key, bytes, { aad: new Uint8Array([1, 2, 3]) })).toBe("secret");
		await expect(decrypt(key, bytes, { aad: new Uint8Array([1, 2, 4]) })).rejects.toThrow();
	});

	it("binds additional authenticated data — string and bytes", async () => {
		const key = await generateDek();
		const strAad = await encrypt(key, "secret", { aad: "vault-secret:7:k" });
		expect(await decryptText(key, strAad, { aad: "vault-secret:7:k" })).toBe("secret");
		// Wrong or missing AAD fails the GCM tag check.
		await expect(decryptText(key, strAad, { aad: "vault-secret:8:k" })).rejects.toThrow();
		await expect(decryptText(key, strAad)).rejects.toThrow();

		const bytesAad = new Uint8Array([1, 2, 3]);
		const env = await encrypt(key, "secret", { aad: bytesAad });
		expect(await decryptText(key, env, { aad: bytesAad })).toBe("secret");
		await expect(decryptText(key, env, { aad: new Uint8Array([1, 2, 4]) })).rejects.toThrow();
	});

	it("binds string AAD into the tag", async () => {
		const key = await generateDek();
		const envelope = await encrypt(key, "payload", { aad: "vault-secret:7:openai-key" });
		expect(await decryptText(key, envelope, { aad: "vault-secret:7:openai-key" })).toBe("payload");
		// Wrong or missing AAD fails the GCM tag check.
		await expect(
			decryptText(key, envelope, { aad: "vault-secret:8:openai-key" }),
		).rejects.toThrow();
		await expect(decryptText(key, envelope)).rejects.toThrow();
	});

	it("binds Uint8Array AAD into the tag", async () => {
		const key = await generateDek();
		const aad = crypto.getRandomValues(new Uint8Array(16));
		const envelope = await encrypt(key, "payload", { aad });
		expect(await decrypt(key, envelope, { aad })).toEqual(new TextEncoder().encode("payload"));
		await expect(
			decrypt(key, envelope, { aad: crypto.getRandomValues(new Uint8Array(16)) }),
		).rejects.toThrow();
	});
});
