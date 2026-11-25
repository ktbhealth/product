import { defineSuite } from "@ktb/eval-core";

/**
 * consult-ptbr-synthetic — the AUTHORED pt-BR multi-specialty cohort
 * (T-042), pinned as `consult-ptbr-synthetic@v2`.
 *
 * Unlike consult-asr-noisy (template-rendered synthetic scripts),
 * this dataset is hand-authored clinical dialogue: 24 consultations
 * across 8 specialties (general_practice, cardiology, dermatology,
 * orthopedics, pediatrics, gynecology, psychiatry, geriatrics),
 * diarized doctor/patient turns with realistic disfluencies — false
 * starts, fillers, self-corrections, spoken numbers/dates,
 * medication names and pt-BR colloquialisms. v2 adds 6 edge-case
 * consults targeting ASR weak spots (negation-dense, polypharmacy,
 * numeric/code-switch, interruptions) plus per-sample `evalSplit`
 * (train/heldout) and `axes` difficulty tags. Gold transcripts +
 * gold entities live in `src/ptbr/` and are projected to Sample
 * rows by `src/ptbr/dataset.ts`.
 *
 * MATERIALIZATION: `eval generate` is NOT the path for this suite —
 * it renders .eta templates and would write DIFFERENT content under
 * the same datasetVersion (the contentHash pin rejects that, loudly,
 * once this dataset is registered). Materialize with:
 *
 *   bun evals/consultation/scripts/materialize-ptbr-synthetic.ts \
 *     --workdir ~/tmp/eval-ptbr-synthetic
 *
 * then run the pipeline (stub profile works offline — audio refs
 * are `pending://` placeholders the stub ASR never reads):
 *
 *   bun apps/cli/src/main.ts eval run consult-ptbr-synthetic \
 *     --workdir ~/tmp/eval-ptbr-synthetic
 *
 * Audio (T-164): render real TTS per consult — per-speaker voices,
 * clinic noise — and rewrite each sample's audio.uri to the
 * produced file:// ref:
 *
 *   bun packages/eval-adapter-local/scripts/render-ptbr-synthetic-audio.ts \
 *     --workdir ~/tmp/eval-ptbr-synthetic
 *
 * then real ASR adapters produce the actual WER signal this cohort
 * exists to measure (`--profile local-asr` + EVAL_ASR_URL).
 *
 * FULL LOCAL REPRO (fresh clone, no external services beyond the
 * two local servers below):
 *
 *   # 1. materialize + render audio (steps above)
 *   # 2. faster-whisper sidecar — CPU needs >60s/file on 3-min
 *   #    consults, so raise the client timeout (server defaults to
 *   #    :8765, which is also the adapter default — EVAL_ASR_URL only
 *   #    needed to override):
 *   uv run --with faster-whisper --with "av==13.*" python \
 *     packages/eval-adapter-local/scripts/asr-server.py &
 *   # 3. pick a profile:
 *   #
 *   #    local-asr               real ASR, stub judge/LLM — WER only
 *   #    local-chat              + OpenAI-compatible LLM corrector
 *   #                            (Ollama: EVAL_LLM_BASE_URL=
 *   #                            http://localhost:11434/v1,
 *   #                            EVAL_LLM_MODEL=qwen3:4b) — no agent
 *   #    local-devin-judge-stub  + spawned ACP agent corrector
 *   #                            (devin CLI; EVAL_ACP_PERMISSION=allow
 *   #                            required — default agent's tool calls
 *   #                            otherwise end turns with no reply)
 *   #
 *   EVAL_ASR_TIMEOUT_MS=300000 \
 *   EVAL_LLM_BASE_URL=http://localhost:11434/v1 \
 *   EVAL_LLM_MODEL=qwen3:4b \
 *     bun apps/cli/src/main.ts eval run consult-ptbr-synthetic \
 *       --workdir ~/tmp/eval-ptbr-synthetic --profile local-chat
 *
 * Measured (faster-whisper base, v1 18 samples): raw WER 0.121 —
 * v2 baseline pending rerun.
 * LLM cleanup ≈0.10 mean offline, in-pipeline verified on subsets.
 */
export const suite = defineSuite({
	id: "consult-ptbr-synthetic",
	domain: "eval.consultation",
	dataset: { id: "consult-ptbr-synthetic", version: "v2" },
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
				materialize: "bun evals/consultation/scripts/materialize-ptbr-synthetic.ts --workdir <dir>",
			},
		},
	},
});
