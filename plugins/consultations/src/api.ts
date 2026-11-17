import * as Schema from "effect/Schema";
import { Event, Query } from "@effect-server-utils/cqrs";
import { Forbidden } from "@ktb/authz";

/** `Forbidden` is a `Data.TaggedError`, not a `Schema` — declare a schema
 * view of it so query failures stay typed end to end. */
const ForbiddenSchema = Schema.declare<Forbidden>((u): u is Forbidden => u instanceof Forbidden);

/** Cross-plugin surface for consultations — queries via
 * `Query.dispatcher`, events via `EventBus`.
 *
 * Minimal audio-pipeline projection for the /platform jobs feed —
 * exactly the fields `jobsFromAudioRows` maps (status filtering stays
 * in the jobs plugin). Cross-owner read: the handler enforces the
 * platform-admin gate and fails `Forbidden` otherwise. */
export const ConsultationsAudioJobs = Query.make("consultations.audioJobs", {
	payload: Schema.Struct({}),
	success: Schema.Array(
		Schema.Struct({
			id: Schema.Number,
			audioStatus: Schema.String,
			audioError: Schema.NullOr(Schema.String),
			createdAt: Schema.Date,
			patientName: Schema.NullOr(Schema.String),
		}),
	),
	failure: ForbiddenSchema,
});

export const ConsultationsQueries = Query.group(ConsultationsAudioJobs);

export const ConsultationCreated = Event.make("consultation.created", {
	id: Schema.Number,
	userId: Schema.String,
	source: Schema.String,
	/** Owning tenant (`groups.id`) or null for personal rows — optional so
	 * pre-tenancy dispatches/tests stay valid; subscribers treat a missing
	 * value as personal scope. */
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

/**
 * Audio-pipeline transition on a consultation (stored → queued →
 * processing → done | failed). Published by every mutation point —
 * the owner-facing service methods and the queue consumer — so the
 * /platform jobs feed can stream live deltas. The payload is a signal,
 * not the row: subscribers re-read the `consultations.audioJobs`
 * projection for the full fields (patientName, createdAt).
 */
export const ConsultationAudioUpdated = Event.make("consultation.audioUpdated", {
	consultationId: Schema.Number,
	audioStatus: Schema.String,
	audioError: Schema.NullOr(Schema.String),
	/** Owning tenant (`groups.id`) or null for personal rows — see
	 * {@link ConsultationCreated}. */
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

/**
 * Row shape behind the `consultations.audioJobs` query — the minimal
 * audio-pipeline projection the /platform jobs feed maps. Canonical
 * here (client-safe) so consumer plugins share one definition instead
 * of re-declaring it. `createdAt` widens to `string` because loader and
 * SSE payloads serialize `Date`s; `patientName` stays optional for the
 * same tolerance. The DB projection always fills both.
 */
export interface AudioJobRow {
	readonly id: number;
	readonly audioStatus: string;
	readonly audioError: string | null;
	readonly createdAt: Date | string;
	readonly patientName?: string | null;
}

/**
 * `audioStatus` values that represent a queued transcription job — the
 * /platform jobs-feed vocabulary (stored → queued → processing → done |
 * failed). "none" (no recording) and "zk" (client-encrypted, T-147) are
 * deliberately absent: neither is a server job.
 */
export const AUDIO_JOB_STATUSES = ["stored", "queued", "processing", "done", "failed"] as const;
export type AudioJobStatus = (typeof AUDIO_JOB_STATUSES)[number];

/**
 * Audio statuses an admin retry may re-queue (T-035): "failed" is the
 * terminal pipeline state and "stored" means the upload landed but the
 * enqueue failed. "queued"/"processing" may have a live delivery in
 * flight — re-enqueueing them risks duplicate transcription — and
 * "done" is terminal-success. A job stuck in "queued" with no pending
 * message has no staleness signal to detect it; recovery stays manual.
 */
export const AUDIO_RETRY_STATUSES = ["stored", "failed"] as const;
