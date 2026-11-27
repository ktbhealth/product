import {
	defaultAudioJobDeps,
	handleAudioQueueBatch as consumeAudioQueueBatch,
	type AudioJobDeps,
	type QueueMessageLike,
} from "@ktb/consultations/audio-consumer";
import { correctTranscript, jobHandlerRegistry } from "#/lib/platform.ts";

export type { AudioJobDeps, QueueMessageLike } from "@ktb/consultations/audio-consumer";

/**
 * App-bound wiring for the transcription queue consumer (T-137): the
 * pipeline itself lives in `@ktb/consultations/audio-consumer` — this
 * module only resolves the host deps (runtime registry bindings via
 * `defaultAudioJobDeps`, the app-host-composed LLM cleanup) and merges
 * the composition-built job-handler registry (lib/platform.ts) for
 * non-audio kinds on the same transport.
 */
export async function handleAudioQueueBatch(
	messages: readonly QueueMessageLike[],
	deps?: AudioJobDeps,
): Promise<void> {
	const resolved =
		deps ?? (await defaultAudioJobDeps((input) => correctTranscript(input).catch(() => null)));
	await consumeAudioQueueBatch(messages, resolved, jobHandlerRegistry.handlers());
}
