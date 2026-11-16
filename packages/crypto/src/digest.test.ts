import { describe, expect, it } from "vitest";

import {
	canonicalize,
	contentHash,
	hexToBytes,
	sha256,
	sha256Hex,
	verifyContentHash,
} from "./digest.ts";
import { bytesToHex, CryptoFormatError } from "./encoding.ts";

const encoder = new TextEncoder();

describe("sha256", () => {
	it("matches the RFC 4231 'abc' vector", async () => {
		// FIPS 180-2 / RFC 4231 test case 1
		expect(bytesToHex(await sha256("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("accepts raw bytes", async () => {
		expect(bytesToHex(await sha256(encoder.encode("abc")))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(await sha256Hex(encoder.encode("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("canonicalize", () => {
	it("sorts object keys recursively", () => {
		const doc = { b: 1, a: { z: 2, y: 3 }, c: [4, 5] };
		expect(canonicalize(doc)).toBe('{"a":{"y":3,"z":2},"b":1,"c":[4,5]}');
	});

	it("keeps array order", () => {
		expect(canonicalize({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
	});

	it("drops undefined and function-valued properties like JSON", () => {
		const doc = { keep: 1, drop: undefined, fn: () => 42, nested: { also: undefined, v: 2 } };
		expect(canonicalize(doc)).toBe('{"keep":1,"nested":{"v":2}}');
	});

	it("normalizes output to NFC", () => {
		// "é" as e + combining acute (NFD) vs precomposed (NFC)
		const nfd = { "cafe\u0301": 1 };
		const nfc = { "caf\u00e9": 1 };
		expect(canonicalize(nfd)).toBe(canonicalize(nfc));
		expect(canonicalize(nfd)).toBe('{"café":1}');
	});

	it("serializes primitives and null at the top level", () => {
		expect(canonicalize(5)).toBe("5");
		expect(canonicalize("x")).toBe('"x"');
		expect(canonicalize(null)).toBe("null");
	});

	it("throws on circular structures", () => {
		const doc: Record<string, unknown> = {};
		doc.self = doc;
		expect(() => canonicalize(doc)).toThrow();
	});
});

describe("contentHash", () => {
	it("is stable across key order", async () => {
		const a = { name: "Ana", age: 30, meds: ["a", "b"] };
		const b = { meds: ["a", "b"], age: 30, name: "Ana" };
		expect(await contentHash(a)).toBe(await contentHash(b));
	});

	it("changes when content changes", async () => {
		expect(await contentHash({ v: 1 })).not.toBe(await contentHash({ v: 2 }));
	});
});

describe("verifyContentHash", () => {
	it("accepts a matching hash", async () => {
		const doc = { a: 1, b: { c: 2 } };
		const hash = await contentHash(doc);
		expect(await verifyContentHash(doc, hash)).toBe(true);
	});

	it("accepts an uppercase expected hash", async () => {
		const doc = { a: 1 };
		const hash = (await contentHash(doc)).toUpperCase();
		expect(await verifyContentHash(doc, hash)).toBe(true);
	});

	it("rejects a tampered document", async () => {
		const hash = await contentHash({ a: 1 });
		expect(await verifyContentHash({ a: 2 }, hash)).toBe(false);
	});

	it("returns false instead of throwing on unserializable input", async () => {
		const doc: Record<string, unknown> = {};
		doc.self = doc;
		expect(await verifyContentHash(doc, "00".repeat(32))).toBe(false);
	});
});

describe("re-exports", () => {
	it("exposes hexToBytes and CryptoFormatError", () => {
		expect(hexToBytes("00ff")).toEqual(new Uint8Array([0, 255]));
		expect(() => hexToBytes("zz")).toThrow(CryptoFormatError);
	});
});
