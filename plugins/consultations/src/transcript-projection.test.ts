import { describe, expect, it } from "vitest";

import {
	b64ToBytes,
	bytesToB64,
	editsBaseText,
	genesisUpdate,
	projectTranscript,
	segBaseOffsets,
	segProjOffset,
	TranscriptEditSession,
} from "./transcript-projection.ts";
import type { TranscriptEditEntry } from "./transcript-edits.ts";

const entry = (u: Uint8Array, by = "u1"): TranscriptEditEntry => ({
	at: new Date().toISOString(),
	by,
	u: bytesToB64(u),
});

describe("transcript projection (PL-023)", () => {
	it("b64 round-trips bytes", () => {
		const bytes = new Uint8Array([0, 1, 128, 255, 42]);
		expect(Array.from(b64ToBytes(bytesToB64(bytes)))).toEqual(Array.from(bytes));
	});

	it("projects the base when the log is empty", () => {
		expect(projectTranscript("sem edições", [])).toBe("sem edições");
	});

	it("falls back to the base when edits erase the whole text", () => {
		const base = "tudo apagado";
		const log = [entry(genesisUpdate(base))];
		const session = new TranscriptEditSession(log);
		log.push(
			entry(
				session.edit((t) => {
					t.delete(0, session.text().length);
				}),
			),
		);
		expect(projectTranscript(base, log)).toBe(base);
	});

	it("seeds a session from base alone — the first edit exports the genesis", () => {
		const session = new TranscriptEditSession([], "texto base");
		expect(session.text()).toBe("texto base");
		const delta = session.edit((t) => {
			t.insert(session.text().length, "!");
		});
		// The first update carries base + delta so peers converge.
		expect(projectTranscript("texto base", [entry(delta)])).toBe("texto base!");
	});

	it("projects genesis-only logs as the base text", () => {
		const base = "O paciente relata dor.";
		expect(projectTranscript(base, [entry(genesisUpdate(base))])).toBe(base);
	});

	it("projects local edits over the genesis base", () => {
		const base = "dor de cabeça.";
		const log = [entry(genesisUpdate(base))];
		const session = new TranscriptEditSession(log);
		const delta = session.edit((t) => {
			t.insert(session.text().length, " Nega febre.");
		});
		log.push(entry(delta));
		expect(projectTranscript(base, log)).toBe("dor de cabeça. Nega febre.");
	});

	it("merges concurrent edits from two devices conflict-free", () => {
		const base = "O paciente relata dor de cabeça.";
		const genesis = entry(genesisUpdate(base));

		// Device A: replace "cabeça" — its own session on the same genesis.
		const a = new TranscriptEditSession([genesis]);
		const da = a.edit((t) => {
			t.delete(24, 6);
			t.insert(24, "enxaqueca");
		});

		// Device B: appends a sentence, also from the same genesis.
		const b = new TranscriptEditSession([genesis]);
		const db = b.edit((t) => {
			t.insert(b.text().length, " Nega febre.");
		});

		// The log converges once both devices exchange deltas — order of
		// the stored entries does not matter to the CRDT.
		const log = [genesis, entry(da, "a"), entry(db, "b")];
		const projected = projectTranscript(base, log);
		expect(projected).toContain("enxaqueca");
		expect(projected).toContain("Nega febre.");
		expect(projected).not.toContain("cabeça. Nega febre. O paciente");
		// And both sessions converge to the same text after cross-import.
		a.importRemote([entry(db, "b")]);
		b.importRemote([entry(da, "a")]);
		expect(a.text()).toBe(b.text());
	});
});

describe("editsBaseText / segment offsets (PL-023)", () => {
	it("returns base when the projected doc ends up empty", () => {
		const base = "x";
		const genesis = entry(genesisUpdate(base));
		const session = new TranscriptEditSession([genesis]);
		const delta = session.edit((t) => {
			t.delete(0, session.text().length);
		});
		expect(projectTranscript("fallback", [genesis, entry(delta)])).toBe("fallback");
	});

	it("picks the pinned base column with null-tolerant fallbacks", () => {
		const c = {
			correctedTranscript: "corr",
			serverTranscript: "srv",
			transcript: "raw",
		};
		expect(editsBaseText({ ...c, transcriptEditsBase: "corrected" })).toBe("corr");
		expect(
			editsBaseText({ ...c, correctedTranscript: null, transcriptEditsBase: "corrected" }),
		).toBe("srv");
		expect(
			editsBaseText({
				correctedTranscript: null,
				serverTranscript: null,
				transcript: "raw",
				transcriptEditsBase: "corrected",
			}),
		).toBe("raw");
		expect(
			editsBaseText({
				correctedTranscript: null,
				serverTranscript: null,
				transcript: null,
				transcriptEditsBase: "corrected",
			}),
		).toBe("");
		expect(
			editsBaseText({ correctedTranscript: null, serverTranscript: null, transcript: null }),
		).toBe("");
		expect(editsBaseText({ ...c, transcriptEditsBase: "server" })).toBe("srv");
		expect(editsBaseText({ ...c, serverTranscript: null, transcriptEditsBase: "server" })).toBe(
			"raw",
		);
		expect(
			editsBaseText({ serverTranscript: null, transcript: null, transcriptEditsBase: "server" }),
		).toBe("");
		expect(editsBaseText({ ...c, transcriptEditsBase: "transcript" })).toBe("raw");
		expect(editsBaseText({ transcriptEditsBase: "transcript" })).toBe("");
		// Unpinned rows fall back through corrected → server → transcript.
		expect(editsBaseText(c)).toBe("corr");
		expect(editsBaseText({ serverTranscript: "srv", transcript: "raw" })).toBe("srv");
		expect(editsBaseText({ transcript: "raw" })).toBe("raw");
		expect(editsBaseText({})).toBe("");
	});

	it("maps segment offsets into base and projected text", () => {
		const segments = [{ text: "alpha" }, { text: "beta gamma" }, { text: "missing" }];
		const base = "xx alpha yy beta gamma zz";
		const baseOffsets = segBaseOffsets(segments, base);
		expect(baseOffsets).toEqual([3, 12, 22]);
		// "missing" is not found → offset stays at the running position.
		expect(segBaseOffsets([{ text: "nope" }], "abc")).toEqual([0]);

		const edits: TranscriptEditEntry[] = [
			{ at: "t", by: "u", u: "", seg: 0, text: "a" },
			{ at: "t", by: "u", u: "", seg: 0 },
			{ at: "t", by: "u", u: "", seg: 5, text: "ignored" },
			{ at: "t", by: "u", u: "" },
		];
		// seg 0 rewrite shrinks by 4 chars; out-of-range index → 0 base.
		expect(segProjOffset(segments, baseOffsets, edits, 1)).toBe(12 - 4);
		expect(segProjOffset(segments, baseOffsets, edits, 9)).toBe(-4);
	});
});
