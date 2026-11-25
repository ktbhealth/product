import { fnvHex } from "../generate.ts";
import type { Sample } from "../schema.ts";
import { PTBR_CONSULTATIONS } from "./consultations.ts";
import type { PtbrConsult } from "./types.ts";

/**
 * dataset.ts — projects authored PtbrConsult records into schema
 * `Sample` rows for the `consult-ptbr-synthetic` dataset (T-042).
 *
 * These are AUTHORED synthetic transcripts — `origin: "synthetic"`
 * is honest (no real patient data anywhere in the cohort) and keeps
 * the PHI gate out of the way: the scripts are already clean,
 * de-identified dialogue.
 *
 * AUDIO: the cohort is transcript-level. Each sample carries an
 * AudioRef under the `pending://` scheme — a deliberate placeholder
 * that no adapter can resolve (makeReadAudioFile accepts file://
 * only, confined to the workdir; blob reads 404). The stub profile
 * never reads audio, so `eval run` works end-to-end offline; the TTS
 * pass is scripts/render-ptbr-synthetic-audio.ts in eval-adapter-local
 * (render each consult's turns with per-speaker voices and rewrite
 * the uri to file://…).
 * blob_meta is registered `synthetic` up-front because the audio,
 * once rendered, IS synthetic TTS of authored text — and because
 * unregistered (`null`) provenance would fail closed on egress
 * adapters anyway.
 */

export const PTBR_SYNTHETIC_DATASET_ID = "consult-ptbr-synthetic";
export const PTBR_SYNTHETIC_DATASET_VERSION = "v1";

/** The datasetVersion stamped on every sample row — MUST equal
 * `${manifest.dataset.id}-${manifest.dataset.version}` for
 * `eval run` to find the cohort (see datasetVersionOf in eval-cli). */
export const ptbrSyntheticDatasetVersion = (): string =>
	`${PTBR_SYNTHETIC_DATASET_ID}-${PTBR_SYNTHETIC_DATASET_VERSION}`;

/** Stable sample id — slug is authored, never derived from content
 * hashes, so ids survive content edits (scriptHash still pins the
 * text for the dataset contentHash). */
export const ptbrSyntheticSampleId = (consult: PtbrConsult): string => `ptbr-${consult.slug}`;

/** Audio placeholder URI — see module header. The scheme is
 * intentionally unresolvable until the TTS step lands. */
export const ptbrSyntheticAudioUri = (consult: PtbrConsult): string =>
	`pending://ptbr-synthetic/${consult.slug}`;

/** Gold provenance tag — authored content validated by the dataset
 * author (T-042), distinct from "generator" (template path) and
 * "physician:<id>" (phase-2 real consults). */
const PTBR_SYNTHETIC_VALIDATED_BY = "author:ptbr-synthetic@v1";

const consultToSample = (consult: PtbrConsult, datasetVersion: string): Sample => {
	const script = consult.turns.map((t) => t.text).join("\n");
	return {
		id: ptbrSyntheticSampleId(consult),
		datasetVersion,
		origin: "synthetic",
		script,
		scriptHash: fnvHex(script),
		persona: {
			region: consult.region,
			ageBand: consult.ageBand,
			register: consult.register,
			specialty: consult.specialty,
			gender: consult.gender,
			socialClass: consult.socialClass,
			education: consult.education,
			name: consult.patientName,
			doctor: { ...consult.doctor },
		},
		turns: consult.turns.map((t) => ({ speaker: t.speaker, text: t.text })),
		// Intended acoustic profile once audio is rendered — "clinic"
		// matches the suite's noise pin. ttsModel/voiceId stay
		// placeholders until the TTS step assigns real aliases.
		acoustic: {
			ttsModel: "pending",
			voiceId: "pending",
			noise: "clinic",
			sampleRate: 16000,
		},
		audio: { uri: ptbrSyntheticAudioUri(consult), contentType: "audio/wav" },
		gold: {
			validatedBy: PTBR_SYNTHETIC_VALIDATED_BY,
			entities: consult.entities.map((e) => ({ ...e })),
		},
	};
};

/** Build the full authored cohort as Sample rows. `limit` slices
 * the stable order — useful for smoke runs; the pinned dataset is
 * always the full list. */
export const buildPtbrSyntheticSamples = (opts?: {
	readonly limit?: number;
	readonly datasetVersion?: string;
}): readonly Sample[] => {
	const version = opts?.datasetVersion ?? ptbrSyntheticDatasetVersion();
	const consults =
		opts?.limit === undefined ? PTBR_CONSULTATIONS : PTBR_CONSULTATIONS.slice(0, opts.limit);
	return consults.map((c) => consultToSample(c, version));
};
