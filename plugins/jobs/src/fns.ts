import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AUDIO_TRANSCRIPTION_JOB_KIND, Consultations } from "@ktb/consultations";
import { forbiddenTo, getServerRuntime, sessionHandler } from "@ktb/server-fns";

import { isAudioRetryable } from "./jobs.ts";

// Ops console server function (T-035): retry a failed/stored audio
// transcription job. Mirrors the upload route's enqueue path — the
// service re-checks the PlatformAdmin gate, the queue message carries
// the row's tenant_id (P-053 phase D), and the "queued" marker is only
// written after the queue accepts the message.

const RetryInput = Schema.Struct({ consultationId: Schema.Number });
const decodeRetryInput = Schema.decodeUnknownSync(RetryInput);

export type RetryAudioResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "not-found" | "not-retryable" | "unavailable" | "enqueue-failed";
	  };

export const retryAudioJobFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRetryInput(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<RetryAudioResult> => {
			// Phase 1 — admin-gated read of the job record. Forbidden
			// collapses to null: non-admins get the same "not-found" shape as
			// a missing row (the /platform guard 404s them first anyway).
			const record = await run(
				Effect.gen(function* () {
					const consultations = yield* Consultations;
					return yield* consultations.adminAudioJob(data.consultationId);
				}).pipe(forbiddenTo(null)),
			);
			if (record === null || record.audioKey === null) {
				return { ok: false, reason: "not-found" };
			}
			if (!isAudioRetryable(record.audioStatus)) {
				return { ok: false, reason: "not-retryable" };
			}
			const { jobs } = getServerRuntime();
			if (jobs === undefined) {
				return { ok: false, reason: "unavailable" };
			}
			try {
				// Same enqueue path as the upload route (PL-007 jobs port) —
				// tenantId comes from the row (authoritative), userId falls
				// back to "" for the nullable legacy column (the consumer
				// skips the owner check when the row's userId is null anyway).
				await jobs.enqueue(
					AUDIO_TRANSCRIPTION_JOB_KIND,
					{
						consultationId: data.consultationId,
						audioKey: record.audioKey,
						userId: record.userId ?? "",
						tenantId: record.tenantId,
					},
					{
						tenantId: record.tenantId,
						payloadRef: `consultation:${data.consultationId}`,
					},
				);
			} catch {
				// Nothing was enqueued — the row keeps its honest failed/stored
				// status; no "queued" marker is written.
				return { ok: false, reason: "enqueue-failed" };
			}
			// Phase 2 — flip stored|failed → queued only after the message is
			// accepted. The conditional update no-ops when the consumer
			// already moved the row (processing/done): the new delivery owns
			// the status then, and a fast permanent failure is a narrow,
			// documented race (the row may sit at "queued" until the next
			// retry — bounded by the queue's own delivery semantics).
			await run(
				Effect.gen(function* () {
					const consultations = yield* Consultations;
					yield* consultations.adminRequeueAudio(data.consultationId);
				}).pipe(Effect.catchTag("Forbidden", () => Effect.void)),
			);
			return { ok: true };
		}),
	);
