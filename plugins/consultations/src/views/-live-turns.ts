import type { LiveConsultationTurn } from "@ktbhealth/ui/components/live-consultation";

/**
 * One flat transcript row as produced by the new-consultation chat
 * parser: the raw "Name:" channel prefix (when present), the resolved
 * display name and the mm:ss capture stamp.
 */
export interface LiveTurnRow {
	readonly speaker?: string;
	readonly name: string;
	readonly text: string;
	readonly time?: string;
}

export interface LiveTurnsOptions {
	/** Localized channel prefixes written into the transcript. */
	readonly doctor: string;
	readonly patient: string;
	/** Display name for the clinician channel — falls back to the
	 * localized prefix when no physician name is known. */
	readonly doctorName?: string;
}

/**
 * Groups flat transcript rows into diarized speaker turns for the
 * LiveConsultation transcript panel. Channel attribution is the only
 * speaker signal the transcriber provides: mic lines → clinician
 * (speaker 0), call-tab lines → patient (speaker 1) and unattributed
 * lines (dictation, pasted text, uploads) → speaker 2. Consecutive
 * rows from the same channel merge into one turn; each row becomes a
 * stamped paragraph.
 */
export function liveConsultationTurns(
	rows: readonly LiveTurnRow[],
	opts: LiveTurnsOptions,
): LiveConsultationTurn[] {
	const turns: LiveConsultationTurn[] = [];
	for (const row of rows) {
		const speaker = row.speaker === opts.doctor ? 0 : row.speaker === opts.patient ? 1 : 2;
		const name = speaker === 0 ? (opts.doctorName ?? row.name) : row.name;
		const paragraph = { time: row.time ?? "", text: row.text };
		const last = turns[turns.length - 1];
		if (last && last.speaker === speaker && last.name === name) {
			last.paragraphs.push(paragraph);
		} else {
			turns.push({ speaker, name, role: row.speaker, paragraphs: [paragraph] });
		}
	}
	return turns;
}
