import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { audioJobRecord, Consultations } from "@ktb/consultations";
import {
	defaultAudioJobDeps,
	handleAudioQueueBatch as consumeAudioQueueBatch,
	type AudioJobDeps,
	type QueueMessageLike,
} from "@ktb/consultations/audio-consumer";
import { Db } from "@ktb/db";
import { jobHandlers } from "@ktb/jobs-port";
import { Effect } from "effect";

import { correctTranscript, run, runAs } from "#/lib/platform.ts";

export type { AudioJobDeps, QueueMessageLike } from "@ktb/consultations/audio-consumer";

/**
 * App-bound wiring for the transcription queue consumer (T-137): the
 * pipeline itself lives in `@ktb/consultations/audio-consumer` — this
 * module only resolves the host deps (runtime registry bindings via
 * `defaultAudioJobDeps`, the app-host-composed LLM cleanup) and merges
 * the shared `jobHandlers` registry (@ktb/jobs-port) for non-audio
 * kinds on the same transport.
 */
export async function handleAudioQueueBatch(
	messages: readonly QueueMessageLike[],
	deps?: AudioJobDeps,
): Promise<void> {
	const resolved =
		deps ?? (await defaultAudioJobDeps((input) => correctTranscript(input).catch(() => null)));
	await consumeAudioQueueBatch(
		messages,
		{ ...resolved, regenerateAnamnesis },
		jobHandlers,
	);
}

/**
 * Regenerate the anamnesis from the LLM-corrected transcript (PL-023):
 * the save-time draft was extracted from the raw transcript, so it goes
 * stale once cleanup lands. Runs through the real service path (owner
 * principal, integrity versions, audit) — rows with a physician
 * approval stamp are left alone since their `anamnesis_reviewed_version`
 * binds the version they signed.
 */
const regenerateAnamnesis = async (consultationId: number, corrected: string): Promise<void> => {
	const owner = await run(
		Effect.gen(function* () {
			const db = yield* Db;
			return yield* Effect.promise(() => audioJobRecord(db, consultationId));
		}),
	);
	const userId = owner?.userId;
	if (userId == null) return;
	await runAs(
		{ id: userId },
		Effect.gen(function* () {
			const consultations = yield* Consultations;
			const detail = yield* consultations
				.get(consultationId, userId)
				.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null)));
			if (
				detail === null ||
				detail.anamnesis === null ||
				detail.anamnesisReviewedVersion != null
			) {
				return;
			}
			const engine = yield* AnamnesisEngine;
			const history =
				detail.patientId === null
					? null
					: yield* consultations
							.history(detail.patientId, userId)
							.pipe(Effect.catch(() => Effect.succeed(null)));
			const draft = yield* engine
				.extract({ transcript: corrected, history: history ?? undefined })
				.pipe(Effect.catch(() => Effect.succeed(null)));
			if (draft === null) return;
			yield* consultations.attachAnamnesis(userId, {
				consultationId,
				anamnesis: draft.anamnesis,
				engine: draft.engine,
			});
		}),
	);
};
