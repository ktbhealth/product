/**
 * Physician transcript edits (PL-023): an append-only JSON log of Loro
 * CRDT update batches stored on `consultations.transcript_edits`. The
 * displayed transcript is always a projection — base text (pinned by
 * `transcript_edits_base`) + imported updates; no snapshot column
 * exists by design. The server treats update blobs opaquely (no WASM);
 * entry metadata (`at`/`by`) stays outside the blob for audit.
 */

export interface TranscriptEditEntry {
	/** ISO timestamp the client recorded the batch at. */
	readonly at: string;
	/** User id that authored the batch. */
	readonly by: string;
	/** base64 Loro update blob. */
	readonly u: string;
}

export type TranscriptEditsBase = "corrected" | "server" | "transcript";

export const TRANSCRIPT_EDITS_BASES: readonly TranscriptEditsBase[] = [
	"corrected",
	"server",
	"transcript",
];

const isEntry = (v: unknown): v is TranscriptEditEntry =>
	!!v &&
	typeof v === "object" &&
	typeof (v as TranscriptEditEntry).at === "string" &&
	typeof (v as TranscriptEditEntry).by === "string" &&
	typeof (v as TranscriptEditEntry).u === "string";

/** Structural check on a serialized log — used on the non-ZK wire
 * input so malformed payloads fail before the UPDATE. */
export const isTranscriptEditsLog = (v: unknown): v is TranscriptEditEntry[] =>
	Array.isArray(v) && v.every(isEntry);

/** Parse the stored column; malformed/empty yields no entries. */
export function parseTranscriptEdits(raw: string | null | undefined): TranscriptEditEntry[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return isTranscriptEditsLog(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function serializeTranscriptEdits(entries: readonly TranscriptEditEntry[]): string {
	return JSON.stringify(entries);
}

/** Which base text the edit ops project over. The browser `transcript`
 * is the universal fallback — audio-less rows carry nothing else. */
export function deriveEditsBase(has: {
	readonly corrected: boolean;
	readonly server: boolean;
}): TranscriptEditsBase {
	if (has.corrected) return "corrected";
	if (has.server) return "server";
	return "transcript";
}
