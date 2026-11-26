import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as path from "node:path";

import { AnamnesisEngine } from "@ktb/anamnesis/services";
import type { Driver } from "@ktb/driver-framework";
import { PipelineRegistry } from "@ktb/pipeline";
import {
	AsrPort,
	cleanupTranscript,
	EvalRunner,
	LlmPort,
	TtsPort,
	wer,
	cer,
	type EvalRunnerItem,
	type RunRecord,
} from "@ktb/eval-consultation";

import { makeLocalAsr } from "./asr.ts";
import { makeLocalTts } from "./tts.ts";

/**
 * Driver providing `EvalRunner` (P-081, T-134): the in-app validator's
 * run step executed through the local pipeline — edge-tts synthesis
 * (multi-voice per turn) → local faster-whisper ASR → WER/CER metrics.
 * Item outcomes stream back through `onSample` so the caller persists
 * progress durably as each sample lands.
 *
 * Eligible only when the workspace env wires it: `EVAL_RUNNER_DIR`
 * (artifact root for audio) + `EVAL_ASR_BASE_URL` (whisper service).
 * Absent → validator runs stay `queued`.
 */
export interface EvalRunnerEnv {
	readonly EVAL_RUNNER_DIR?: string;
	readonly EVAL_ASR_BASE_URL?: string;
	readonly EVAL_ASR_TIMEOUT_MS?: string;
}

/** The eight clinical sections of the persisted anamnesis schema —
 * completeness = how many came back non-empty. `historico` is context,
 * never scored. */
const ANAMNESIS_SECTIONS = [
	"queixa_principal",
	"hda",
	"antecedentes",
	"alergias",
	"medicamentos_em_uso",
	"exame_fisico",
	"hipoteses",
	"conduta",
] as const;

/** Build the `EvalRunner` impl over an injected TTS+ASR port layer —
 * separated from the local-adapter wiring so tests (and future
 * adapters reusing the same orchestration) can swap the ports.
 *
 * Downstream stages run the REAL production chain when the ambient
 * runtime binds their ports: `LlmPort` → surface cleanup (reversible
 * edits, WER recomputed on the corrected text) and `AnamnesisEngine`
 * → the same extractor the consultations plugin calls. Both are
 * optional and failure-isolated — a missing/failed stage lands as an
 * `error` field and never loses the ASR metrics. */
export const makeEvalRunner = <E>(ports: Layer.Layer<TtsPort | AsrPort, E>) => {
	const runOne = (item: EvalRunnerItem) =>
		Effect.gen(function* () {
			const tts = yield* TtsPort;
			const asr = yield* AsrPort;
			// Per-stage audit trail — every port record is tagged with
			// this item's identity (same `eval-<id>` namespace the
			// cleanup taskId uses) and returned on the outcome so the
			// platform can persist it (WS-D). datasetVersion stays
			// absent: the runner doesn't know the cohort's manifest.
			const records: RunRecord[] = [];
			const tag = (r: RunRecord): RunRecord => ({
				...r,
				runId: `eval-${item.id}`,
				sampleId: String(item.id),
			});
			const { audio, record: ttsRecord } = yield* tts.synthesize({
				script: item.script,
				voiceId: "br_male_1",
				acoustic: {
					ttsModel: "edge-tts",
					voiceId: "br_male_1",
					noise: "clean",
					sampleRate: 24000,
				},
				turns: item.turns,
				speakerVoices: item.voices,
			});
			records.push(tag(ttsRecord));
			const { asr: asrResult, record: asrRecord } = yield* asr.transcribe(audio, {
				language: "pt",
			});
			records.push(tag(asrRecord));
			const asrText = asrResult.text;

			// Preferred path when the runtime binds a PipelineRegistry
			// that knows the shared `consultation-transcript` pack (the
			// app composition root registers every plugin's packs): the
			// pipeline stages resolve the platform decision/generative
			// endpoints themselves, so cleanup works even without an
			// ambient LlmPort. Unbound registry, unknown pipeline id,
			// disabled cleanup, or a run failure all yield undefined and
			// fall through to the direct LlmPort path — behavior with no
			// registry bound is byte-identical to before.
			const registryOpt = yield* Effect.serviceOption(PipelineRegistry);
			const pipelineCleanup:
				| { edits: number; corrected: string; werAfter: number; cerAfter: number }
				| undefined = yield* Option.isNone(registryOpt) ||
			!registryOpt.value.has("consultation-transcript")
				? Effect.succeed(undefined)
				: Effect.gen(function* () {
						const result = yield* registryOpt.value
							.run("consultation-transcript", {
								text: asrText,
								segments: asrResult.segments,
								taskId: `eval-${item.id}`,
							})
							.pipe(
								Effect.catch((error) =>
									Effect.logWarning("eval transcript pipeline failed, using direct cleanup", {
										error: String(error),
									}).pipe(Effect.as(null)),
								),
								Effect.catchDefect((defect) =>
									Effect.logWarning("eval transcript pipeline failed, using direct cleanup", {
										error: String(defect),
									}).pipe(Effect.as(null)),
								),
							);
						if (result === null) return undefined;
						const cleanup = result.state.cleanup as
							| {
									readonly enabled?: unknown;
									readonly corrected?: unknown;
									readonly edits?: unknown;
									readonly records?: unknown;
							  }
							| undefined;
						if (cleanup?.enabled !== true || typeof cleanup.corrected !== "string") {
							return undefined;
						}
						// The stages already emit RunRecords (corrector calls,
						// gate judge batches) — tag them into this item's
						// audit trail like every other stage record.
						if (Array.isArray(cleanup.records)) {
							for (const r of cleanup.records as readonly RunRecord[]) {
								records.push(tag(r));
							}
						}
						return {
							edits: typeof cleanup.edits === "number" ? cleanup.edits : 0,
							corrected: cleanup.corrected,
							werAfter: wer(item.script, cleanup.corrected),
							cerAfter: cer(item.script, cleanup.corrected),
						};
					});

			const llm = yield* Effect.serviceOption(LlmPort);
			const cleanup =
				pipelineCleanup ??
				(Option.isNone(llm)
					? undefined
					: yield* cleanupTranscript({
							taskId: `eval-${item.id}`,
							raw: asrText,
							// onRecord fires before edit application — a
							// corrupt-edit-list failure still keeps the
							// corrector's audit record.
							onRecord: (r) => records.push(tag(r)),
						}).pipe(
							Effect.provideService(LlmPort, llm.value),
							Effect.map((r) => ({
								edits: r.edits.ops.length,
								corrected: r.corrected,
								werAfter: wer(item.script, r.corrected),
								cerAfter: cer(item.script, r.corrected),
							})),
							Effect.catch((error: unknown) => Effect.succeed({ error: String(error) })),
						));
			const corrected =
				cleanup !== undefined && "corrected" in cleanup ? cleanup.corrected : undefined;

			const engine = yield* Effect.serviceOption(AnamnesisEngine);
			const anamnesis = Option.isNone(engine)
				? undefined
				: yield* engine.value
						.extract({
							transcript: corrected ?? asrText,
							...(item.patient !== undefined ? { patient: item.patient } : {}),
						})
						.pipe(
							Effect.map((r) => {
								const filled = ANAMNESIS_SECTIONS.filter(
									(k) => r.anamnesis[k].content.trim().length > 0,
								).length;
								return {
									engine: r.engine,
									sections: ANAMNESIS_SECTIONS.length,
									filled,
									completeness: filled / ANAMNESIS_SECTIONS.length,
									json: r.anamnesis,
								};
							}),
							Effect.catch((error: unknown) => Effect.succeed({ error: String(error) })),
						);

			return {
				result: {
					audioUri: audio.uri,
					asrText,
					wer: wer(item.script, asrText),
					cer: cer(item.script, asrText),
					confSegments: asrResult.segments,
					stages: [
						"asr",
						...(cleanup !== undefined ? ["cleanup"] : []),
						...(anamnesis !== undefined ? ["anamnesis"] : []),
					],
					...(cleanup !== undefined ? { cleanup } : {}),
					...(anamnesis !== undefined ? { anamnesis } : {}),
				},
				records,
			};
		});

	return Layer.succeed(
		EvalRunner,
		EvalRunner.of({
			run: ({ items, onSample }) =>
				Effect.forEach(
					items,
					(item) =>
						runOne(item).pipe(
							Effect.provide(ports),
							Effect.flatMap((out) =>
								onSample(item.id, { status: "ok", result: out.result, records: out.records }),
							),
							Effect.catch((error) =>
								onSample(item.id, { status: "failed", error: String(error) }),
							),
						),
					{ concurrency: 1, discard: true },
				),
		}),
	);
};

export const evalRunnerLocalDriver: Driver<EvalRunnerEnv> = {
	id: "eval-runner-local",
	port: EvalRunner.key,
	when: (env) => Boolean(env.EVAL_RUNNER_DIR) && Boolean(env.EVAL_ASR_BASE_URL),
	provides: (env) => {
		const workDir = env.EVAL_RUNNER_DIR!;
		const baseUrl = env.EVAL_ASR_BASE_URL!;
		const parsedTimeout = Number(env.EVAL_ASR_TIMEOUT_MS);
		const timeoutMs = Number.isFinite(parsedTimeout) ? parsedTimeout : 1_800_000;

		return makeEvalRunner(
			Layer.merge(
				makeLocalTts({ workDir: path.join(workDir, "tts"), voiceMap: {} }),
				makeLocalAsr({ baseUrl, timeoutMs }),
			),
		);
	},
};
