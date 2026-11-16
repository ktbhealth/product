import { describe, expect, it } from "vitest";

import { decodeFrame, makeFrameExtractor } from "./framing.ts";

const drain = (chunks: readonly (string | Uint8Array)[]) => {
	const f = makeFrameExtractor();
	for (const c of chunks) f.push(c);
	const out: string[] = [];
	for (let n = f.next(); n !== null; n = f.next()) out.push(decodeFrame(n));
	return out;
};

describe("makeFrameExtractor", () => {
	it("extracts newline-delimited frames", () => {
		expect(drain(['{"a":1}\n{"b":2}\n'])).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("waits for a complete line across chunk boundaries", () => {
		expect(drain(['{"a":1', "}", "\n"])).toEqual(['{"a":1}']);
	});

	it("extracts Content-Length frames (CRLF header)", () => {
		expect(drain(['Content-Length: 9\r\n\r\n{"a":"b"}'])).toEqual(['{"a":"b"}']);
	});

	it("extracts Content-Length frames (LF-only header)", () => {
		expect(drain(['Content-Length: 9\n\n{"a":"b"}'])).toEqual(['{"a":"b"}']);
	});

	it("waits for the full Content-Length body across chunks", () => {
		expect(drain(['Content-Length: 9\r\n\r\n{"a":', '"b"}'])).toEqual(['{"a":"b"}']);
	});

	it("counts Content-Length in bytes (multibyte payloads)", () => {
		const json = JSON.stringify({ t: "é" }); // 10 bytes, 9 chars
		expect(
			drain([`Content-Length: ${new TextEncoder().encode(json).length}\r\n\r\n${json}`]),
		).toEqual([json]);
	});

	it("surfaces a corrupt header as a non-JSON frame", () => {
		expect(drain(["Content-Length: x\r\n\r\n{}\n"])).toEqual(["<corrupt header>", "{}"]);
	});

	it("accepts raw byte chunks", () => {
		const enc = new TextEncoder();
		expect(drain([enc.encode('{"a":1}\n')])).toEqual(['{"a":1}']);
	});
});
