import { describe, expect, it } from "vitest";

import { exportDek } from "./aead.ts";
import {
	decodeRecoveryPhrase,
	encodeRecoveryPhrase,
	generateMasterKey,
	importRecoveryPhrase,
} from "./recovery.ts";

describe("recovery phrase", () => {
	it("generates an extractable master key and a printable phrase", async () => {
		const { key, phrase } = await generateMasterKey();
		expect(key.extractable).toBe(true);
		// 33 payload bytes → 53 base32 chars → 13 full groups + tail.
		expect(phrase).toMatch(/^([a-z2-7]{4}-){13}[a-z2-7]$/);
	});

	it("round-trips key material", async () => {
		const { key, phrase } = await generateMasterKey();
		const bytes = await decodeRecoveryPhrase(phrase);
		expect(bytes).toEqual(await exportDek(key));
		const restored = await importRecoveryPhrase(phrase);
		expect(await exportDek(restored)).toEqual(await exportDek(key));
	});

	it("accepts loose formatting — spaces, no dashes, upper case", async () => {
		const { key, phrase } = await generateMasterKey();
		const sloppy = phrase.replace(/-/g, " ").toUpperCase();
		expect(await decodeRecoveryPhrase(sloppy)).toEqual(await exportDek(key));
		expect(await decodeRecoveryPhrase(phrase.replace(/-/g, ""))).toEqual(await exportDek(key));
	});

	it("rejects a corrupted phrase at the checksum", async () => {
		const { phrase } = await generateMasterKey();
		// Corrupt the stored checksum byte, not the key: the final base32
		// char carries the checksum's low nibble plus a zero pad bit, so
		// flipping its bit 1 changes the decoded checksum while leaving
		// keyBytes — and the zero pad — intact. Corrupting the key instead
		// is ~1/256 flaky: the 1-byte checksum can collide by chance.
		const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
		const tail = alphabet.indexOf(phrase.at(-1)!);
		const bad = phrase.slice(0, -1) + alphabet[tail ^ 2];
		await expect(decodeRecoveryPhrase(bad)).rejects.toThrow(/checksum mismatch/);
	});

	it("rejects dangling non-zero bits — a phrase missing its tail", async () => {
		// "b" decodes to 5 bits with a non-zero leftover that can never
		// complete a byte — padding-less base32 must fail loudly here.
		await expect(decodeRecoveryPhrase("b")).rejects.toThrow(/truncated/);
	});

	it("rejects wrong length and invalid characters", async () => {
		await expect(decodeRecoveryPhrase("aaaa-aaaa")).rejects.toThrow(/wrong length/);
		await expect(
			decodeRecoveryPhrase("xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-0"),
		).rejects.toThrow(/invalid character/);
	});

	it("rejects a non-256-bit key", async () => {
		await expect(encodeRecoveryPhrase(new Uint8Array(16))).rejects.toThrow(/256 bits/);
	});
});
