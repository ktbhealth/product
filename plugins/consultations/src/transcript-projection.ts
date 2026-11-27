/**
 * Client-side transcript projection (PL-023): rebuilds the readable
 * transcript from the base + the Loro update log — never a stored
 * snapshot. `loro-crdt` (WASM) lives ONLY here: server modules
 * (`service`, `fns`, `audio-*`) treat update blobs opaquely and must
 * not import this file.
 *
 * Model: `transcript_edits[0]` is the *genesis* update — the base-text
 * insert exported from the doc that first produced edits. Every
 * device seeds by importing the full log, then appends its own deltas
 * (`export({mode:"update", from: vv})`). Same genesis on every peer is
 * what keeps merges conflict-free — re-inserting the base text
 * locally would duplicate it on merge.
 */
import { LoroDoc, type VersionVector } from "loro-crdt";

import type { TranscriptEditEntry } from "./transcript-edits.ts";

export const b64ToBytes = (b64: string): Uint8Array =>
	Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export const bytesToB64 = (bytes: Uint8Array): string => {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};

/** The transcript the doctor reads: import every stored update into a
 * fresh doc and stringify. No edits → the base text itself. */
export function projectTranscript(base: string, edits: readonly TranscriptEditEntry[]): string {
	if (edits.length === 0) return base;
	const doc = new LoroDoc();
	for (const e of edits) doc.import(b64ToBytes(e.u));
	return doc.getText("t").toString() || base;
}

/** Build the genesis update for a first edit session: a doc seeded
 * with `base` — this becomes `transcript_edits[0]` and every later
 * edit imports it. */
export function genesisUpdate(base: string): Uint8Array {
	const doc = new LoroDoc();
	doc.getText("t").insert(0, base);
	doc.commit();
	return doc.export({ mode: "update" });
}

/** Which stored column the edit log projects over — the pin written on
 * the first save wins so late pipeline stages never rebase old ops. */
export function editsBaseText(c: {
	readonly correctedTranscript?: string | null;
	readonly serverTranscript?: string | null;
	readonly transcript?: string | null;
	readonly transcriptEditsBase?: string | null;
}): string {
	const pick = (b: "corrected" | "server" | "transcript") =>
		b === "corrected"
			? (c.correctedTranscript ?? c.serverTranscript ?? c.transcript)
			: b === "server"
				? (c.serverTranscript ?? c.transcript)
				: c.transcript;
	if (c.transcriptEditsBase === "corrected") return pick("corrected") ?? "";
	if (c.transcriptEditsBase === "server") return pick("server") ?? "";
	if (c.transcriptEditsBase === "transcript") return pick("transcript") ?? "";
	return c.correctedTranscript ?? c.serverTranscript ?? c.transcript ?? "";
}

/** Char offset of each segment in the BASE text — sequential
 * `indexOf`, tolerant to drift (falls back to the previous end). */
export function segBaseOffsets(
	segments: readonly { readonly text: string }[],
	base: string,
): readonly number[] {
	const out: number[] = [];
	let from = 0;
	for (const s of segments) {
		const at = base.indexOf(s.text, from);
		out.push(at === -1 ? from : at);
		from = (at === -1 ? from : at) + s.text.length;
	}
	return out;
}

/** Offset of segment `i` inside the *projected* doc — base offset plus
 * the length deltas of earlier segment rewrites. */
export function segProjOffset(
	segments: readonly { readonly text: string }[],
	baseOffsets: readonly number[],
	entries: readonly TranscriptEditEntry[],
	i: number,
): number {
	let off = baseOffsets[i] ?? 0;
	for (const e of entries) {
		if (e.seg != null && e.text != null && e.seg < i) {
			const orig = segments[e.seg]?.text;
			if (orig != null) off += e.text.length - orig.length;
		}
	}
	return off;
}

/**
 * Editing session over a projected doc: wrap local mutations in
 * `edit()`, which returns the update blob the caller appends to the
 * stored log as `{at, by, u}`.
 */
export class TranscriptEditSession {
	private readonly doc = new LoroDoc();
	private vv: VersionVector | null;

	/** Seed from the stored log. When the log is empty, `base` is
	 * inserted as the genesis content — the first `edit()` then exports
	 * a *full* update (genesis + delta), which becomes
	 * `transcript_edits[0]` for every peer. */
	constructor(edits: readonly TranscriptEditEntry[], base?: string) {
		if (edits.length === 0 && base != null) {
			this.doc.getText("t").insert(0, base);
			this.doc.commit();
		}
		for (const e of edits) this.doc.import(b64ToBytes(e.u));
		this.vv = edits.length === 0 ? null : this.doc.version();
	}

	/** Current projected text. */
	text(): string {
		return this.doc.getText("t").toString();
	}

	/** Apply a mutation; returns the delta update to append to the log. */
	edit(
		mutate: (text: {
			insert: (pos: number, s: string) => void;
			delete: (pos: number, len: number) => void;
		}) => void,
	): Uint8Array {
		mutate(this.doc.getText("t"));
		this.doc.commit();
		// `vv === null` means the doc was seeded with the base text and
		// has no imported history: the first delta must carry the genesis
		// insert too, so it exports the full state, not a range.
		const delta =
			this.vv === null
				? this.doc.export({ mode: "update" })
				: this.doc.export({ mode: "update", from: this.vv });
		this.vv = this.doc.version();
		return delta;
	}

	/** Import updates from other devices (conflict-free merge). */
	importRemote(entries: readonly TranscriptEditEntry[]): void {
		for (const e of entries) this.doc.import(b64ToBytes(e.u));
	}
}
