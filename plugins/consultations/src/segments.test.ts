import { describe, expect, it } from "vitest";

import {
	extractTranscriptSegments,
	parseTranscriptSegments,
	serializeTranscriptSegments,
	type TranscriptSegment,
} from "./segments.ts";

describe("extractTranscriptSegments", () => {
	it("returns null for non-object payloads and missing segments", () => {
		expect(extractTranscriptSegments(null)).toBeNull();
		expect(extractTranscriptSegments("x")).toBeNull();
		expect(extractTranscriptSegments({})).toBeNull();
		expect(extractTranscriptSegments({ segments: "nope" })).toBeNull();
	});

	it("extracts tolerant segment entries and skips malformed ones", () => {
		const raw = {
			segments: [
				{ start: 0, end: 1.5, text: "olá", avg_logprob: -0.2 },
				{ start: 1.5, end: 3, text: "mundo", avgLogprob: -0.5 },
				{ start: 3, end: 4, text: "sem confiança" },
				null,
				"junk",
				{ start: "x", end: 5, text: "bad start" },
				{ start: 5, end: 6 }, // missing text
				{ start: Number.NaN, end: 7, text: "nan" },
			],
		};
		expect(extractTranscriptSegments(raw)).toEqual([
			{ start: 0, end: 1.5, text: "olá", avgLogprob: -0.2 },
			{ start: 1.5, end: 3, text: "mundo", avgLogprob: -0.5 },
			{ start: 3, end: 4, text: "sem confiança" },
		]);
	});

	it("returns null when every entry is malformed", () => {
		expect(extractTranscriptSegments({ segments: [null, { start: 1 }] })).toBeNull();
		expect(extractTranscriptSegments({ segments: [] })).toBeNull();
	});
});

describe("serialize/parse transcript segments", () => {
	const segs: TranscriptSegment[] = [
		{ start: 0, end: 1, text: "a" },
		{ start: 1, end: 2, text: "b", avgLogprob: -0.1 },
	];

	it("round-trips segments and maps empty input to null", () => {
		expect(serializeTranscriptSegments(segs)).toBe(JSON.stringify(segs));
		expect(serializeTranscriptSegments([])).toBeNull();
		expect(serializeTranscriptSegments(null)).toBeNull();
		expect(serializeTranscriptSegments(undefined)).toBeNull();
		expect(parseTranscriptSegments(serializeTranscriptSegments(segs))).toEqual(segs);
	});

	it("parse tolerates empty, malformed and non-array payloads", () => {
		expect(parseTranscriptSegments(null)).toEqual([]);
		expect(parseTranscriptSegments("")).toEqual([]);
		expect(parseTranscriptSegments("not json")).toEqual([]);
		expect(parseTranscriptSegments('{"a":1}')).toEqual([]);
	});

	it("parse filters entries missing required fields", () => {
		const raw = JSON.stringify([
			{ start: 0, end: 1, text: "ok" },
			{ start: 0, end: 1 },
			{ start: "0", end: 1, text: "bad" },
			"junk",
			{ start: 1, end: 2, text: "ok2", extra: true },
		]);
		expect(parseTranscriptSegments(raw)).toEqual([
			{ start: 0, end: 1, text: "ok" },
			{ start: 1, end: 2, text: "ok2", extra: true },
		]);
	});
});
