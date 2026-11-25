import type { GoldEntity } from "../schema.ts";

/**
 * ptbr/ — the authored pt-BR consultation cohort (T-042).
 *
 * Unlike the template-rendered synthetic path (scriptgen.ts), these
 * records are HAND-AUTHORED dataset content: realistic Brazilian
 * Portuguese clinical dialogue with the disfluencies real consult
 * audio carries — false starts, fillers ("éé", "ahn", "tipo"),
 * self-corrections, spoken numbers/dates, brand+generic medication
 * names and colloquial register. The gold transcript IS the spoken
 * text (diarized doctor/patient turns); WER/CER score ASR output
 * against it downstream.
 *
 * Content rules: symptoms/anamnesis/exam-plan only — no diagnosis or
 * treatment recommendation copy (product positioning: the physician
 * decides, KTB records). All names are synthetic display tags
 * ("Paciente Helena"), never real identifiers.
 */

type PtbrSpeaker = "doctor" | "patient";

interface PtbrTurn {
	readonly speaker: PtbrSpeaker;
	readonly text: string;
}

/** One authored consultation — everything needed to project a
 * schema `Sample` row (see dataset.ts). */
export interface PtbrConsult {
	/** Stable slug — becomes the sample id suffix (`ptbr-<slug>`). */
	readonly slug: string;
	/** Persona-matrix specialty literal (same vocabulary as
	 * personas.ts DEFAULT_MATRIX). */
	readonly specialty: string;
	readonly region: string;
	readonly ageBand: string;
	readonly register: string;
	/** Patient gender — "f" | "m". */
	readonly gender: string;
	readonly socialClass: string;
	readonly education: string;
	/** Synthetic display tag — never a real name. */
	readonly patientName: string;
	readonly doctor: {
		readonly gender: string;
		readonly register: string;
	};
	/** Diarized dialogue, in spoken order. The first turn is the
	 * doctor's greeting by convention (not enforced). */
	readonly turns: readonly PtbrTurn[];
	/** Gold clinical entities — every `value` MUST appear verbatim
	 * (modulo metrics.normalize) inside the joined turn text; the
	 * dataset test enforces this so entity verdicts stay meaningful. */
	readonly entities: readonly GoldEntity[];
	/** Eval split assignment — "heldout" rows are excluded from
	 * tuning/iteration and scored once at the end. Absent = "train".
	 * PTBR_SYNTHETIC_HELDOUT_SLUGS (dataset.ts) can force "heldout"
	 * for a slug without editing the consult. */
	readonly split?: "train" | "heldout";
	/** Difficulty/content axis tags for stratified reporting —
	 * e.g. "negation-dense", "polypharmacy", "numeric-dense",
	 * "code-switch", "disfluency-heavy", "colloquial",
	 * "interruptions". Free-form; absent = untagged. */
	readonly axes?: readonly string[];
}
