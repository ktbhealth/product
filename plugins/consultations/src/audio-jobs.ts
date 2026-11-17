import { and, desc, eq, inArray } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { consultations, patients } from "@ktb/db/schema";

import { rowTenantIsZk } from "./lifecycle.ts";
import { AUDIO_RETRY_STATUSES, type AudioJobRow } from "./api.ts";

// Canonical home is ./api.ts (client-safe cross-plugin surface); the
// root index re-exports both names through this module unchanged.
export { AUDIO_RETRY_STATUSES, type AudioJobRow } from "./api.ts";

// ---------- audio pipeline (system paths — queue consumer, no principal) ----------

export interface AudioJobFields {
	readonly audioKey: string;
	readonly contentType?: string;
	readonly size?: number;
}

/** Status the owner-facing routes may set after enqueue; terminal states are consumer-only.
 * "zk" (T-147): ciphertext stored for approved-device retrieval — the server
 * transcription pipeline never runs for it. */
export const AUDIO_ROUTE_STATUSES = ["queued", "zk"] as const;
export type AudioRouteStatus = (typeof AUDIO_ROUTE_STATUSES)[number];

/**
 * Job kind for the async transcription pipeline on the shared jobs
 * queue (PL-007). Producers (upload route, admin retry) and the
 * apps/web consumer registration all dispatch on this literal.
 */
export const AUDIO_TRANSCRIPTION_JOB_KIND = "transcription.audio";

/** Record the R2 object link after a successful upload (status "stored"). */
export async function attachAudioRecord(
	db: DbClient,
	consultationId: number,
	fields: AudioJobFields,
) {
	await db
		.update(consultations)
		.set({
			audioKey: fields.audioKey,
			audioStatus: "stored",
			audioContentType: fields.contentType ?? null,
			audioSize: fields.size ?? null,
			audioError: null,
		})
		.where(eq(consultations.id, consultationId));
}

/** stored → queued once the transcription job was enqueued. */
export async function markAudioQueued(db: DbClient, consultationId: number) {
	await markAudioRouteStatus(db, consultationId, "queued");
}

/** Route-set audio status ("queued" after enqueue, "zk" for ciphertext). */
export async function markAudioRouteStatus(
	db: DbClient,
	consultationId: number,
	status: AudioRouteStatus,
) {
	await db
		.update(consultations)
		.set({ audioStatus: status, audioError: null })
		.where(eq(consultations.id, consultationId));
}

export interface AudioJobRecord {
	readonly audioKey: string | null;
	readonly audioStatus: string;
	readonly userId: string | null;
	readonly tenantId: number | null;
}

/** Consumer lookup: fetch the audio linkage regardless of caller. The
 * row's `tenant_id` is the authoritative tenant scope for the job —
 * queue payloads only hint at it (P-053 phase D). */
export async function audioJobRecord(
	db: DbClient,
	consultationId: number,
): Promise<AudioJobRecord | null> {
	const rows = await db
		.select({
			audioKey: consultations.audioKey,
			audioStatus: consultations.audioStatus,
			userId: consultations.userId,
			tenantId: consultations.tenantId,
		})
		.from(consultations)
		.where(eq(consultations.id, consultationId))
		.limit(1);
	return rows[0] ?? null;
}

export async function beginAudioJob(db: DbClient, consultationId: number) {
	await db
		.update(consultations)
		.set({ audioStatus: "processing", audioError: null })
		.where(eq(consultations.id, consultationId));
}

/** Server transcript persisted — the raw ASR evidence. No-op under
 * ZK: the Whisper pipeline never runs there (T-147), and a plaintext
 * server transcript would defeat the cipher spec. */
export async function completeAudioJob(db: DbClient, consultationId: number, transcript: string) {
	if (await rowTenantIsZk(db, consultationId)) return;
	await db
		.update(consultations)
		.set({ serverTranscript: transcript, audioStatus: "done", audioError: null })
		.where(eq(consultations.id, consultationId));
}

export async function failAudioJob(db: DbClient, consultationId: number, reason: string) {
	await db
		.update(consultations)
		.set({ audioStatus: "failed", audioError: reason })
		.where(eq(consultations.id, consultationId));
}

/**
 * Re-queue marker for the admin retry path: flips a retryable
 * consultation back to "queued" and clears the error. The UPDATE is
 * conditional on the retryable set so a concurrent consumer transition
 * (processing/done) is never overwritten. Returns false when the row
 * is missing or already past the retryable states.
 */
export async function requeueAudioJob(db: DbClient, consultationId: number): Promise<boolean> {
	const rows = await db
		.update(consultations)
		.set({ audioStatus: "queued", audioError: null })
		.where(
			and(
				eq(consultations.id, consultationId),
				inArray(consultations.audioStatus, [...AUDIO_RETRY_STATUSES]),
			),
		)
		.returning({ id: consultations.id });
	return rows.length > 0;
}

/**
 * LLM-cleaned transcript alongside the original — never overwrites
 * serverTranscript. Status stays "done"; correctedTranscript stays null
 * when no LLM is configured or the call fails.
 */
export async function saveCorrectedTranscript(
	db: DbClient,
	consultationId: number,
	corrected: string,
	engine: string,
) {
	if (await rowTenantIsZk(db, consultationId)) return;
	await db
		.update(consultations)
		.set({ correctedTranscript: corrected, enhancementEngine: engine })
		.where(eq(consultations.id, consultationId));
}

/**
 * DB projection row behind the audio-job repo reads — narrower than the
 * client-facing {@link AudioJobRow}: `createdAt` is always a `Date` and
 * `patientName` always present (null when the consultation has no
 * linked patient). The wide API shape only exists because loader and
 * SSE payloads serialize Dates and tolerate absent names.
 */
export interface AudioJobDbRow {
	readonly id: number;
	readonly audioStatus: string;
	readonly audioError: string | null;
	readonly createdAt: Date;
	readonly patientName: string | null;
}

/**
 * Cross-owner audio-pipeline listing for the /platform jobs feed.
 * Callers MUST have passed the `PlatformAdmin` gate first — this repo
 * function itself is unauthenticated, like `listAllConsultations`.
 */
export async function listAudioJobRows(db: DbClient): Promise<AudioJobDbRow[]> {
	return db
		.select({
			id: consultations.id,
			audioStatus: consultations.audioStatus,
			audioError: consultations.audioError,
			createdAt: consultations.createdAt,
			patientName: patients.name,
		})
		.from(consultations)
		.leftJoin(patients, eq(consultations.patientId, patients.id))
		.orderBy(desc(consultations.id));
}

/** Single-row variant of `listAudioJobRows` — the live-delta lookup the
 * `consultation.audioUpdated` subscriber re-reads after each event. */
export async function audioJobRow(
	db: DbClient,
	consultationId: number,
): Promise<AudioJobDbRow | null> {
	const rows = await db
		.select({
			id: consultations.id,
			audioStatus: consultations.audioStatus,
			audioError: consultations.audioError,
			createdAt: consultations.createdAt,
			patientName: patients.name,
		})
		.from(consultations)
		.leftJoin(patients, eq(consultations.patientId, patients.id))
		.where(eq(consultations.id, consultationId))
		.limit(1);
	return rows[0] ?? null;
}
