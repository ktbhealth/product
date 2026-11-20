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

	it("returns null until a newline arrives", () => {
		const f = makeFrameExtractor();
		f.push('{"a":1');
		expect(f.next()).toBeNull();
		f.push("}\n");
		const frame = f.next();
		expect(frame).not.toBeNull();
		expect(decodeFrame(frame!)).toBe('{"a":1}');
	});

	it("returns null while a Content-Length header is incomplete", () => {
		const f = makeFrameExtractor();
		f.push("Content-Length: 9");
		expect(f.next()).toBeNull();
	});

	it("returns null until the Content-Length body is complete", () => {
		const f = makeFrameExtractor();
		f.push('Content-Length: 9\r\n\r\n{"a":');
		expect(f.next()).toBeNull();
		f.push('"b"}');
		const frame = f.next();
		expect(frame).not.toBeNull();
		expect(decodeFrame(frame!)).toBe('{"a":"b"}');
	});

	it("accepts Content-Length without whitespace after the colon", () => {
		expect(drain(["Content-Length:9\r\n\r\n123456789"])).toEqual(["123456789"]);
	});

	it("returns an empty frame for a zero Content-Length body", () => {
		const f = makeFrameExtractor();
		f.push("Content-Length: 0\r\n\r\n");
		const frame = f.next();
		expect(frame).not.toBeNull();
		expect(decodeFrame(frame!)).toBe("");
	});
});
