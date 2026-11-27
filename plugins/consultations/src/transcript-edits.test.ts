import { describe, expect, it } from "vitest";

import {
	deriveEditsBase,
	isTranscriptEditsLog,
	parseTranscriptEdits,
	serializeTranscriptEdits,
	TRANSCRIPT_EDITS_BASES,
	type TranscriptEditEntry,
} from "./transcript-edits.ts";

const entry = (over: Partial<TranscriptEditEntry> = {}): TranscriptEditEntry => ({
	at: "2026-01-01T00:00:00Z",
	by: "u1",
	u: "AAAA",
	...over,
});

describe("transcript edits log (PL-023)", () => {
	it("isTranscriptEditsLog validates entry shape", () => {
		expect(isTranscriptEditsLog([entry()])).toBe(true);
		expect(isTranscriptEditsLog([entry({ seg: 2, text: "x" })])).toBe(true);
		expect(isTranscriptEditsLog([])).toBe(true);
		expect(isTranscriptEditsLog("x")).toBe(false);
		expect(isTranscriptEditsLog([entry(), { at: 1 }])).toBe(false);
		expect(isTranscriptEditsLog([{ at: "a", by: "b" }])).toBe(false); // missing u
	});

	it("parse tolerates empty, malformed and invalid payloads", () => {
		expect(parseTranscriptEdits(null)).toEqual([]);
		expect(parseTranscriptEdits(undefined)).toEqual([]);
		expect(parseTranscriptEdits("")).toEqual([]);
		expect(parseTranscriptEdits("{}")).toEqual([]);
		expect(parseTranscriptEdits('"x"')).toEqual([]);
		expect(parseTranscriptEdits("not json")).toEqual([]);
		expect(parseTranscriptEdits('{"a":1}')).toEqual([]);
		expect(parseTranscriptEdits("[1,2]")).toEqual([]);
		expect(parseTranscriptEdits("[null]")).toEqual([]);
		expect(parseTranscriptEdits('[{"at":"t","by":"u"}]')).toEqual([]);
	});

	it("parse round-trips a valid log", () => {
		const log = [entry(), entry({ seg: 0, text: "edited", by: "u2" })];
		const raw = serializeTranscriptEdits(log);
		expect(parseTranscriptEdits(raw)).toEqual(log);
	});

	it("deriveEditsBase prefers corrected, then server, then transcript", () => {
		expect(deriveEditsBase({ corrected: true, server: true })).toBe("corrected");
		expect(deriveEditsBase({ corrected: false, server: true })).toBe("server");
		expect(deriveEditsBase({ corrected: false, server: false })).toBe("transcript");
		expect(TRANSCRIPT_EDITS_BASES).toEqual(["corrected", "server", "transcript"]);
	});
});
