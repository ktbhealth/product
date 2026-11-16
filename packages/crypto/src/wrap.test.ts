import { describe, expect, it } from "vitest";

import { decryptText, encrypt, generateDek } from "./aead.ts";
import { bytesToB64u, CryptoFormatError } from "./encoding.ts";
import { hkdfToAesKey } from "./kdf.ts";
import {
	exportWrapPrivateKey,
	exportWrapPublicKey,
	generateWrapKeyPair,
	importWrapPrivateKey,
	importWrapPublicKey,
	unwrapDek,
	wrapDek,
} from "./wrap.ts";

/** Rebuild a w1 blob by hand with an arbitrary inner payload — used to
 * exercise the "not a 256-bit key" guard that wrapDek can never emit. */
const craftWrapBlob = async (recipientPublicKey: CryptoKey, inner: Uint8Array) => {
	const ephemeral = await generateWrapKeyPair();
	const bits = await crypto.subtle.deriveBits(
		{ name: "ECDH", public: recipientPublicKey },
		ephemeral.privateKey,
		256,
	);
	const kek = await hkdfToAesKey(new Uint8Array(bits), new Uint8Array(0), "ktb.dek-wrap.v1");
	const envelope = await encrypt(kek, inner);
	const ephPub = bytesToB64u(
		new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)),
	);
	return `w1.${ephPub}.${envelope.split(".").slice(1).join(".")}`;
};

describe("ECIES DEK wrap (w1)", () => {
	it("wraps and unwraps a DEK end to end", async () => {
		const recipient = await generateWrapKeyPair();
		const dek = await generateDek();
		const blob = await wrapDek(dek, recipient.publicKey);
		expect(blob.startsWith("w1.")).toBe(true);
		expect(blob.split(".")).toHaveLength(4);

		const unwrapped = await unwrapDek(blob, recipient.privateKey);
		// The unwrapped key must be usable as the original DEK.
		const envelope = await encrypt(dek, "patient note");
		expect(await decryptText(unwrapped, envelope)).toBe("patient note");
	});

	it("produces a distinct blob per wrap (fresh ephemeral pair)", async () => {
		const recipient = await generateWrapKeyPair();
		const dek = await generateDek();
		expect(await wrapDek(dek, recipient.publicKey)).not.toBe(
			await wrapDek(dek, recipient.publicKey),
		);
	});

	it("fails for a different recipient's private key", async () => {
		const a = await generateWrapKeyPair();
		const b = await generateWrapKeyPair();
		const blob = await wrapDek(await generateDek(), a.publicKey);
		await expect(unwrapDek(blob, b.privateKey)).rejects.toThrow();
	});

	it("rejects malformed blobs", async () => {
		const { privateKey } = await generateWrapKeyPair();
		await expect(unwrapDek("nope", privateKey)).rejects.toThrow(CryptoFormatError);
		await expect(unwrapDek("v1.a.b.c", privateKey)).rejects.toThrow(CryptoFormatError);
		await expect(unwrapDek("w1.a.b.c.d", privateKey)).rejects.toThrow(CryptoFormatError);
		await expect(unwrapDek("w1.a.b", privateKey)).rejects.toThrow(CryptoFormatError);
	});

	it("rejects a blob whose inner payload is not a 256-bit key", async () => {
		const recipient = await generateWrapKeyPair();
		const blob = await craftWrapBlob(recipient.publicKey, new Uint8Array(8));
		await expect(unwrapDek(blob, recipient.privateKey)).rejects.toThrow(CryptoFormatError);
		await expect(unwrapDek(blob, recipient.privateKey)).rejects.toThrow(
			"wrapped payload is not a 256-bit key",
		);
	});

	it("rejects a tampered inner envelope", async () => {
		const recipient = await generateWrapKeyPair();
		const blob = await wrapDek(await generateDek(), recipient.publicKey);
		const [w, eph, iv, ct] = blob.split(".");
		const tampered = `${w}.${eph}.${iv}.${ct!.slice(0, -2)}${ct!.endsWith("00") ? "11" : "00"}`;
		await expect(unwrapDek(tampered, recipient.privateKey)).rejects.toThrow();
	});
});

describe("wrap key import/export", () => {
	it("round-trips the key pair through export/import", async () => {
		const pair = await generateWrapKeyPair();
		const pub = await exportWrapPublicKey(pair.publicKey);
		const priv = await exportWrapPrivateKey(pair.privateKey);

		const dek = await generateDek();
		const blob = await wrapDek(dek, await importWrapPublicKey(pub));
		const unwrapped = await unwrapDek(blob, await importWrapPrivateKey(priv));
		const envelope = await encrypt(dek, "round-trip");
		expect(await decryptText(unwrapped, envelope)).toBe("round-trip");
	});

	it("supports non-extractable public key import", async () => {
		const pair = await generateWrapKeyPair();
		const pub = await exportWrapPublicKey(pair.publicKey);
		const imported = await importWrapPublicKey(pub, false);
		expect(imported.extractable).toBe(false);
		const blob = await wrapDek(await generateDek(), imported);
		await expect(unwrapDek(blob, pair.privateKey)).resolves.toBeDefined();
	});

	it("supports non-extractable private key import", async () => {
		const pair = await generateWrapKeyPair();
		const priv = await exportWrapPrivateKey(pair.privateKey);
		const imported = await importWrapPrivateKey(priv, false);
		expect(imported.extractable).toBe(false);
		const blob = await wrapDek(await generateDek(), pair.publicKey);
		await expect(unwrapDek(blob, imported)).resolves.toBeDefined();
	});

	it("rejects invalid base64url key material synchronously", () => {
		expect(() => importWrapPublicKey("!!!")).toThrow(CryptoFormatError);
		expect(() => importWrapPrivateKey("!!!")).toThrow(CryptoFormatError);
	});
});
