import { defineSuite } from "@ktb/eval-core";

/**
 * consult-ptbr-real — the AUTHORED pt-BR multi-specialty cohort
 * (T-042), pinned as `consult-ptbr-real@v1`.
 *
 * Unlike consult-asr-noisy (template-rendered synthetic scripts),
 * this dataset is hand-authored clinical dialogue: 18 consultations
 * across 6 specialties (general_practice, cardiology, dermatology,
 * orthopedics, pediatrics, gynecology), diarized doctor/patient
 * turns with realistic disfluencies — false starts, fillers,
 * self-corrections, spoken numbers/dates, medication names and
 * pt-BR colloquialisms. Gold transcripts + gold entities live in
 * `src/ptbr/` and are projected to Sample rows by
 * `src/ptbr/dataset.ts`.
 *
 * MATERIALIZATION: `eval generate` is NOT the path for this suite —
 * it renders .eta templates and would write DIFFERENT content under
 * the same datasetVersion (the contentHash pin rejects that, loudly,
 * once this dataset is registered). Materialize with:
 *
 *   bun evals/consultation/scripts/materialize-ptbr-real.ts \
 *     --workdir /tmp/eval-ptbr-real
 *
 * then run the pipeline (stub profile works offline — audio refs
 * are `pending://` placeholders the stub ASR never reads):
 *
 *   bun apps/cli/src/main.ts eval run consult-ptbr-real \
 *     --workdir /tmp/eval-ptbr-real
 *
 * Audio (T-164): render real TTS per consult — per-speaker voices,
 * clinic noise — and rewrite each sample's audio.uri to the
 * produced file:// ref:
 *
 *   bun packages/eval-adapter-local/scripts/render-ptbr-real-audio.ts \
 *     --workdir /tmp/eval-ptbr-real
 *
 * then real ASR adapters produce the actual WER signal this cohort
 * exists to measure (`--profile local-asr` + EVAL_ASR_URL).
 */
export const suite = defineSuite({
	id: "consult-ptbr-real",
	domain: "eval.consultation",
	dataset: { id: "consult-ptbr-real", version: "v1" },
	stages: ["script_gen", "synthesize", "transcribe", "cleanup", "judge"],
	caps: {
		tts: "transcription.tts",
		asr: "transcription.asr",
		llm: "llm.eval",
		eval: "llm.eval",
		store: "storage.dataset",
		report: "storage.dataset",
		registry: "storage.dataset",
	},
	metrics: ["wer", "cer", "entity-verdicts", "confidence-calibration", "risk-score"],
	gates: [{ preset: "consult.standard" }],
	schemaVersion: 1,
	adapterProfile: "stub",
	domainParams: {
		params: {
			dataset: {
				source: "authored",
				pack: "evals/consultation/src/ptbr",
				count: 18,
				specialties: [
					"general_practice",
					"cardiology",
					"dermatology",
					"orthopedics",
					"pediatrics",
					"gynecology",
				],
				materialize: "bun evals/consultation/scripts/materialize-ptbr-real.ts --workdir <dir>",
			},
		},
	},
});
