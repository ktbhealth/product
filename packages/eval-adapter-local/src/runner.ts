import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as path from "node:path";

import type { Driver } from "@ktb/driver-framework";
import {
	AsrPort,
	EvalRunner,
	TtsPort,
	wer,
	cer,
	type EvalRunnerItem,
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

/** Build the `EvalRunner` impl over an injected TTS+ASR port layer —
 * separated from the local-adapter wiring so tests (and future
 * adapters reusing the same orchestration) can swap the ports. */
export const makeEvalRunner = <E>(ports: Layer.Layer<TtsPort | AsrPort, E>) => {
	const runOne = (item: EvalRunnerItem) =>
		Effect.gen(function* () {
			const tts = yield* TtsPort;
			const asr = yield* AsrPort;
			const { audio } = yield* tts.synthesize({
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
			const { asr: asrResult } = yield* asr.transcribe(audio, { language: "pt" });
			const asrText = asrResult.text;
			return {
				audioUri: audio.uri,
				asrText,
				wer: wer(item.script, asrText),
				cer: cer(item.script, asrText),
				confSegments: asrResult.segments,
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
							Effect.flatMap((result) => onSample(item.id, { status: "ok", result })),
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
