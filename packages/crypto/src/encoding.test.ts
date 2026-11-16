import { describe, expect, it } from "vitest";

import { b64uToBytes, bytesToB64u, bytesToHex, CryptoFormatError, hexToBytes } from "./encoding.ts";

describe("base64url", () => {
	it("round-trips arbitrary bytes", () => {
		const cases = [
			new Uint8Array(0),
			new Uint8Array([0]),
			new Uint8Array([255, 254]),
			new Uint8Array([1, 2, 3]),
			crypto.getRandomValues(new Uint8Array(64)),
			crypto.getRandomValues(new Uint8Array(65)),
			crypto.getRandomValues(new Uint8Array(66)),
		];
		for (const bytes of cases) {
			expect(b64uToBytes(bytesToB64u(bytes))).toEqual(bytes);
		}
	});

	it("is url-safe and unpadded", () => {
		const encoded = bytesToB64u(new Uint8Array([251, 255, 190]));
		expect(encoded).toBe("-_--");
		expect(encoded).not.toMatch(/[+/=]/);
	});

	it("decodes the empty string", () => {
		expect(b64uToBytes("")).toEqual(new Uint8Array(0));
	});

	it("rejects impossible lengths", () => {
		expect(() => b64uToBytes("A")).toThrow(CryptoFormatError);
		expect(() => b64uToBytes("ABCDE")).toThrow(CryptoFormatError);
	});

	it("rejects non-alphabet characters", () => {
		expect(() => b64uToBytes("AA+A")).toThrow(CryptoFormatError);
		expect(() => b64uToBytes("AA/A")).toThrow(CryptoFormatError);
	});

	it("rejects characters outside the byte range", () => {
		expect(() => b64uToBytes("AAAĀ")).toThrow(CryptoFormatError);
	});
});

describe("hex", () => {
	it("round-trips", () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 255]);
		expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
		expect(bytesToHex(hexToBytes("00ff"))).toBe("00ff");
	});

	it("rejects odd length", () => {
		expect(() => hexToBytes("abc")).toThrow(CryptoFormatError);
	});

	it("rejects non-hex characters", () => {
		expect(() => hexToBytes("zz")).toThrow(CryptoFormatError);
	});
});
