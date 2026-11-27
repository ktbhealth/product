import { describe, expect, it } from "vitest";

import {
	b64ToBytes,
	bytesToB64,
	genesisUpdate,
	projectTranscript,
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
