import { defineSuite } from "@ktb/eval-core";

/**
 * consult-asr-noisy — the pinned pt-BR noisy multi-specialty cohort
 * (T-042).
 *
 * Same pipeline vocabulary as consult-asr.suite.ts; the difference is
 * the DATASET PIN: `dataset {id, version}` is the DatasetManifest
 * registry key, and `domainParams.params.dataset` pins the generator
 * inputs that make the cohort reproducible —
 *
 *   noise: "clinic"   — the noisy acoustic profile (vs "clean")
 *   count: 12         — cohort size after matrix sub-sampling
 *   step: 5           — persona-matrix stride (multi-specialty spread)
 *   seed: 4242        — script/persona RNG base
 *
 * `eval generate consult-asr-noisy` registers
 * `consult-asr-noisy@v1` whose contentHash covers every sample's
 * id+scriptHash — regenerating under the same pin with different
 * content is rejected, and the same pin reproduces the same cohort.
 * pt-BR is the domain default locale (eval.consultation → ptbr-v1);
 * the persona matrix already spans the specialty set.
 */
export const suite = defineSuite({
	id: "consult-asr-noisy",
	domain: "eval.consultation",
	dataset: { id: "consult-asr-noisy", version: "v1" },
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
			dataset: { count: 12, step: 5, seed: 4242, noise: "clinic" },
		},
	},
});
