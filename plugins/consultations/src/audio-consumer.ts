import { Schema } from "effect";
import * as Effect from "effect/Effect";

import { EventBus } from "@effect-server-utils/cqrs";
import { audit } from "@ktb/audit";
import { Db } from "@ktb/db";
import type { DbClient } from "@ktb/db";
import {
	decodeJobEnvelope,
	makeJobConsumer,
	type JobHandlers,
	type JobMessageLike,
	type JobRegistration,
	type NormalizedJob,
} from "@ktb/jobs-port";
import { getServerRuntime, peekServerRuntime, run } from "@ktb/server-fns";
import type { AudioJobMessage } from "@ktb/server-fns";
import { runAsTenantId } from "@ktb/tenant";
import { tenantIsZk } from "@ktb/vault";

import { ConsultationAudioUpdated } from "./api.ts";
import {
	AUDIO_TRANSCRIPTION_JOB_KIND,
	audioJobRecord,
	beginAudioJob,
	completeAudioJob,
	failAudioJob,
	saveCorrectedTranscript,
	type AudioJobRecord,
} from "./audio-jobs.ts";

/**
 * Async transcription pipeline (P-016/P-017): queue consumer that runs
 * Workers AI whisper-large-v3-turbo on the R2-stored recording, then an
 * LLM cleanup pass producing correctedTranscript alongside the original.
 *
 * Everything here is a system path — no Principal; the job payload is
 * produced by the authenticated upload route and re-validated against
 * the D1 row (owner match) before any work happens.
 *
 * Platform bindings arrive through the @ktb/server-fns runtime
 * registry (host-resolved, incl. dev stand-ins) — this module never
 * reads env or cloudflare:* modules itself (P-033).
 */

/**
 * Workers AI rejects oversized audio and chunked transcription is not
 * supported — recordings above this are marked failed, not split.
 * (~25MB is the documented ceiling for a single Whisper call.)
 * Canonical home: the /api/transcribe route enforces the same ceiling.
 */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const AudioJobMessageSchema = Schema.Struct({
	consultationId: Schema.Number,
	audioKey: Schema.String,
	userId: Schema.String,
	// Optional + nullable: pre-tenancy messages carry no tenant_id and
	// decode as personal scope (P-053 phase D backward compat).
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

const decodeAudioJob = Schema.decodeUnknownSync(AudioJobMessageSchema);

/** Minimal R2 read surface — the real R2Bucket (and the dev:node
 * filesystem stand-in) satisfy this; the runtime registry's AudioStore
 * type is narrower, so the composition root casts at the boundary. */
export interface AudioBucketLike {
	get(key: string): Promise<{ readonly size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface AudioTranscriber {
	run(model: string, inputs: unknown): Promise<unknown>;
}

interface CorrectedTranscript {
	readonly corrected: string;
	readonly engine: string;
}

export interface AudioJobDeps {
	readonly db: DbClient;
	readonly bucket: AudioBucketLike | undefined;
	readonly ai: AudioTranscriber | undefined;
	/** Transcription model id — host-resolved deploy config
	 * (AUDIO_TRANSCRIBE_MODEL via the runtime registry). */
	readonly model: string;
	readonly correctTranscript: (transcript: string) => Promise<CorrectedTranscript | null>;
	/**
	 * Live fan-out for the /platform jobs feed: the consumer is a system
	 * path (no Principal), so the default wiring dispatches a
	 * `ConsultationAudioUpdated` EventBus event through the app
	 * runtime. Optional — tests may omit it; a missing/rejected publish
	 * never fails the job.
	 */
	readonly publishAudioUpdate?: (update: {
		readonly consultationId: number;
		readonly audioStatus: string;
		readonly audioError: string | null;
		/** Row's tenant_id (null = personal) — forwarded onto the
		 * `consultation.audioUpdated` event and the rebound tenant scope. */
		readonly tenantId: number | null;
	}) => Promise<void>;
	/** Audit-trail hook (P-080): records transcription terminal events.
	 * Optional — tests may omit it; a missing/rejected write never
	 * fails the job (same contract as publishAudioUpdate). */
	readonly recordAudit?: (entry: {
		readonly action: string;
		readonly targetType?: string | null;
		readonly targetId?: string | number | null;
		readonly detail?: Readonly<Record<string, unknown>> | null;
		readonly tenantId?: string | number | null;
	}) => Promise<void>;
}

/** btoa without stack overflow on large buffers (chunked fromCharCode). */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/**
 * PT-BR clinical glossary biasing Whisper decoding via `initial_prompt`
 * (Workers AI caps the prompt at ~224 tokens). Generic Whisper mangles
 * drug names, exam acronyms and CID/TUSS references; listing the
 * high-frequency vocabulary steers the decoder toward them.
 */
export const WHISPER_CLINICAL_PROMPT =
	"Consulta médica em português brasileiro. Vocabulário clínico frequente: " +
	"hipertensão arterial, diabetes mellitus, dislipidemia, hipotireoidismo, obesidade, " +
	"rinite, sinusite, faringite, amigdalite, otite, asma, bronquite, gastrite, úlcera péptica, " +
	"diarreia, constipação, lombalgia, cervicalgia, osteoartrite, anemia, taquicardia, arritmia, " +
	"hipotensão, hemograma, glicemia de jejum, hemoglobina glicosilada, creatinina, ureia, TSH, " +
	"colesterol LDL, HDL, triglicerídeos, MAPA, eletrocardiograma, radiografia, tomografia, " +
	"ressonância magnética, dipirona, paracetamol, ibuprofeno, amoxicilina, azitromicina, " +
	"ciprofloxacino, sinvastatina, losartana, hidroclorotiazida, metformina, omeprazol, insulina, " +
	"prednisona, CID-10, TUSS, SUS, convênio, receita de controle especial, atestado médico, " +
	"encaminhamento, retorno.";

/** whisper-class models take base64 audio (unlike number[] models)
 * with a fixed language hint — shared with the /api/transcribe route.
 * `vad_filter` + `condition_on_previous_text: false` are the Workers AI
 * anti-hallucination knobs; the local OpenAI-compatible adapter maps
 * `initial_prompt` onto its `prompt` form field and ignores the rest. */
export function whisperInputs(audioBase64: string) {
	return {
		audio: audioBase64,
		language: "pt",
		initial_prompt: WHISPER_CLINICAL_PROMPT,
		vad_filter: true,
		condition_on_previous_text: false,
	};
}

/** Tolerant text extraction across Workers AI response shapes. */
export function extractWhisperText(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (raw && typeof raw === "object") {
		const r = raw as Record<string, unknown>;
		if (typeof r.text === "string") return r.text;
		if (typeof r.transcription === "string") return r.transcription;
	}
	throw new Error("Workers AI returned an unrecognized transcription shape");
}

export async function transcribeAudio(
	transcriber: AudioTranscriber,
	audio: Uint8Array,
	model: string,
): Promise<string> {
	const raw = await transcriber.run(model, whisperInputs(bytesToBase64(audio)));
	return extractWhisperText(raw);
}

/** Best-effort live notification — publishing is a side channel, so a
 * failure here must never fail (or retry) the transcription job. */
const notify = (
	deps: AudioJobDeps,
	consultationId: number,
	audioStatus: string,
	audioError: string | null,
	tenantId: number | null,
) =>
	deps.publishAudioUpdate?.({ consultationId, audioStatus, audioError, tenantId }).catch(() => {});

/** Reasons reaching the audit log are safe fixed strings except the
 * provider-error suffix (`transcription failed: <raw error>`) — reduce
 * that one to its bare label so no provider internals are stored. */
const coarseReason = (reason: string): string =>
	reason.startsWith("transcription failed") ? "transcription failed" : reason;

/** Audit write is a side channel like publish — a missing/rejected
 * hook never fails (or retries) the transcription job. Detail carries
 * ids/flags only: the provider error embedded in `reason` is coerced
 * to a coarse label before it reaches the log. */
const recordAudit = (
	deps: AudioJobDeps,
	consultationId: number,
	action: string,
	reason: string | null,
	tenantId: number | null,
) =>
	deps
		.recordAudit?.({
			action,
			targetType: "consultation",
			targetId: consultationId,
			tenantId,
			detail: reason === null ? null : { reason: coarseReason(reason) },
		})
		.catch(() => {});

const fail = async (
	deps: AudioJobDeps,
	consultationId: number,
	reason: string,
	tenantId: number | null,
) => {
	await failAudioJob(deps.db, consultationId, reason);
	await notify(deps, consultationId, "failed", reason, tenantId);
	await recordAudit(deps, consultationId, "consultations.transcription.failed", reason, tenantId);
};

/**
 * Process one transcription job. Permanent failures (missing row/object,
 * oversized audio, empty result, AI rejection) mark the consultation
 * failed and return; unexpected errors propagate so the queue retries.
 * Idempotent: a consultation already "done" is skipped, so redelivered
 * messages are safe.
 */
export async function processAudioJob(job: AudioJobMessage, deps: AudioJobDeps): Promise<void> {
	const row: AudioJobRecord | null = await audioJobRecord(deps.db, job.consultationId);
	// Tenant scope for this job (P-053 phase D): the row's tenant_id is
	// authoritative; the payload's tenantId is only a hint for the
	// missing-row path. Missing/absent → null = personal scope.
	const tenantId = row === null ? (job.tenantId ?? null) : row.tenantId;
	if (row === null) {
		await fail(deps, job.consultationId, "consultation not found", tenantId);
		return;
	}
	if (row.audioStatus === "done") return; // idempotent skip
	// T-147 fail-closed: a ZK tenant's audio is client-encrypted before
	// upload, so a Whisper job should never exist for it. If one slips
	// through anyway, refuse before the ciphertext reaches the provider
	// and record the violation on the row.
	if (tenantId !== null && (await tenantIsZk(deps.db, tenantId))) {
		await fail(
			deps,
			job.consultationId,
			"zero-knowledge audio — server transcription unavailable",
			tenantId,
		);
		return;
	}
	const audioKey = row.audioKey ?? job.audioKey;
	if (!audioKey) {
		await fail(deps, job.consultationId, "no audio key recorded", tenantId);
		return;
	}
	// The payload is untrusted queue data: the D1 row is the source of
	// truth for ownership and linkage.
	if (row.userId !== null && job.userId !== row.userId) {
		await fail(deps, job.consultationId, "audio job owner mismatch", tenantId);
		return;
	}
	if (!deps.bucket || !deps.ai) {
		await fail(deps, job.consultationId, "audio pipeline not configured", tenantId);
		return;
	}

	await beginAudioJob(deps.db, job.consultationId);
	await notify(deps, job.consultationId, "processing", null, tenantId);
	const object = await deps.bucket.get(audioKey);
	if (object === null) {
		await fail(deps, job.consultationId, "audio object missing from storage", tenantId);
		return;
	}
	if (object.size > MAX_AUDIO_BYTES) {
		await fail(
			deps,
			job.consultationId,
			`audio too large for server transcription (${object.size} bytes > ${MAX_AUDIO_BYTES})`,
			tenantId,
		);
		return;
	}

	const bytes = new Uint8Array(await object.arrayBuffer());
	let transcript: string;
	try {
		transcript = await transcribeAudio(deps.ai, bytes, deps.model);
	} catch (error) {
		await fail(deps, job.consultationId, `transcription failed: ${String(error)}`, tenantId);
		return;
	}
	if (!transcript.trim()) {
		await fail(deps, job.consultationId, "transcription returned empty text", tenantId);
		return;
	}
	await completeAudioJob(deps.db, job.consultationId, transcript);
	await notify(deps, job.consultationId, "done", null, tenantId);
	// P-080: transcription itself is complete — audit before the
	// best-effort cleanup block below.
	await recordAudit(
		deps,
		job.consultationId,
		"consultations.transcription.completed",
		null,
		tenantId,
	);

	// P-017: LLM cleanup chained in the same job. Failure leaves
	// correctedTranscript null; audioStatus stays "done".
	try {
		const corrected = await deps.correctTranscript(transcript);
		if (corrected) {
			await saveCorrectedTranscript(
				deps.db,
				job.consultationId,
				corrected.corrected,
				corrected.engine,
			);
		}
	} catch (error) {
		console.warn("transcript cleanup failed; keeping original only", {
			consultationId: job.consultationId,
			error: String(error),
		});
	}
}

export type QueueMessageLike = JobMessageLike;

// ---------- side-effect defaults (system path — no Principal) ----------

/**
 * Default live fan-out: dispatch `ConsultationAudioUpdated` through the
 * app runtime, rebinding the tenant scope from the job's tenant_id
 * (P-053 phase D) so subscribers see the same fence a request would.
 * `run` binds no Principal; EventBus.dispatch needs none (subscribers
 * re-check authz on their own read paths).
 */
const defaultPublishAudioUpdate = (update: {
	readonly consultationId: number;
	readonly audioStatus: string;
	readonly audioError: string | null;
	readonly tenantId: number | null;
}): Promise<void> =>
	// Deferred so a missing runtime registry rejects the promise instead
	// of throwing synchronously into the caller — notify() swallows both.
	Promise.resolve().then(() =>
		run(
			runAsTenantId(
				update.tenantId,
				Effect.gen(function* () {
					const events = yield* EventBus;
					yield* events.dispatch([
						ConsultationAudioUpdated.make({
							consultationId: update.consultationId,
							audioStatus: update.audioStatus,
							audioError: update.audioError,
							tenantId: update.tenantId,
						}),
					]);
				}),
			),
		),
	);

/** Default audit hook (P-080): same system-path wrapper as the publish
 * default — tenant scope rebound; audit() itself is a no-op when the
 * audit plugin is absent. */
const defaultRecordAudit = (entry: {
	readonly action: string;
	readonly targetType?: string | null;
	readonly targetId?: string | number | null;
	readonly detail?: Readonly<Record<string, unknown>> | null;
	readonly tenantId?: string | number | null;
}): Promise<void> =>
	Promise.resolve().then(() =>
		run(
			runAsTenantId(
				entry.tenantId ?? null,
				Effect.gen(function* () {
					yield* audit(entry);
				}),
			),
		),
	);

/**
 * Fill the optional side-effect hooks with their production defaults
 * when the app runtime is bound (it always is on the queue consumer
 * path). Outside the composed app — bare unit tests — the hooks stay
 * absent and notify/audit degrade to no-ops exactly like an omitted
 * dep.
 */
const withSideEffectDefaults = (deps: AudioJobDeps): AudioJobDeps => {
	// peekServerRuntime is the non-throwing probe — the throwing
	// getServerRuntime would defeat the degrade-to-noop contract.
	if (peekServerRuntime() === undefined) return deps;
	return {
		...deps,
		publishAudioUpdate: deps.publishAudioUpdate ?? defaultPublishAudioUpdate,
		recordAudit: deps.recordAudit ?? defaultRecordAudit,
	};
};

/**
 * Kind → payload registration for `transcription.audio` (PL-007): the
 * payload keeps the legacy AudioJobMessage shape; tenant scope for the
 * run comes from the normalized envelope (which folds in the payload's
 * tenantId for pre-envelope messages).
 */
const audioJobRegistration = (deps: AudioJobDeps): JobRegistration => {
	const effective = withSideEffectDefaults(deps);
	return {
		decodePayload: (payload) => decodeAudioJob(payload),
		handle: (payload, envelope) => {
			const job = payload as AudioJobMessage;
			// Envelope scope is authoritative; the normalizer already folded
			// the legacy payload's tenantId into it.
			const tenantId = envelope.tenantId ?? null;
			return run(
				// System path — `run` binds no Principal; the tenant scope is
				// rebound explicitly from the job's tenant_id (P-053 phase D)
				// so subscribers see the same fence a request would.
				runAsTenantId(
					tenantId,
					Effect.promise(() => processAudioJob(job, effective)).pipe(
						Effect.withSpan("queue.audio.transcribe", {
							attributes: { "ktb.job.kind": envelope.kind },
						}),
					),
				),
			);
		},
	};
};

/**
 * Wire normalizer for the shared jobs queue: canonical envelopes decode
 * via @ktb/jobs-port; pre-PL-007 bodies were bare AudioJobMessage
 * payloads and map onto `transcription.audio`. Anything else is poison.
 */
export const normalizeAudioJobBody = (body: unknown): NormalizedJob | null => {
	const envelope = decodeJobEnvelope(body);
	if (envelope !== null) return envelope;
	// A body that claims a `kind` but failed envelope decode is a
	// malformed envelope — poison, not a legacy audio payload.
	if (body !== null && typeof body === "object" && "kind" in body) return null;
	try {
		const payload = decodeAudioJob(body);
		return {
			kind: AUDIO_TRANSCRIPTION_JOB_KIND,
			payload,
			tenantId: payload.tenantId ?? null,
		};
	} catch {
		return null;
	}
};

/**
 * Production deps for the consumer: bindings resolved through the
 * @ktb/server-fns runtime registry (R2 bucket, Workers AI, model id)
 * plus the Db service inside the app runtime. `correctTranscript` is
 * the app-host-composed LLM cleanup — the composition root hands it
 * in because it is bound to deploy env, not a registry capability.
 * Only valid inside the composed app (queue consumer path).
 */
export const defaultAudioJobDeps = async (
	correctTranscript: AudioJobDeps["correctTranscript"],
): Promise<AudioJobDeps> => {
	const runtime = getServerRuntime();
	const db = await run(
		Effect.gen(function* () {
			return yield* Db;
		}),
	);
	return {
		db,
		// AudioStore's get() omits arrayBuffer in its type; the real R2
		// object (and the dev:node stand-in) both provide it.
		bucket: runtime.audio as unknown as AudioBucketLike | undefined,
		ai: runtime.ai as AudioTranscriber | undefined,
		model: runtime.audioTranscribeModel,
		correctTranscript,
	};
};

/**
 * Queue batch handler for the shared jobs transport — invoked from the
 * worker's `queue` export (server.ts dispatches non-theme batches
 * here) and from the dev:node local queue. `transcription.audio` is
 * served by this module's registration; `handlers` carries the
 * composition root's kind → handler registry for every other kind
 * (PL-007). Malformed messages are acked (poison), valid jobs that
 * throw unexpectedly are retried by the queue, and every delivery
 * updates the `job_runs` projection when a DbClient is bound.
 */
export async function handleAudioQueueBatch(
	messages: readonly QueueMessageLike[],
	deps: AudioJobDeps,
	handlers: JobHandlers = {},
): Promise<void> {
	const consumer = makeJobConsumer({
		handlers: {
			...handlers,
			[AUDIO_TRANSCRIPTION_JOB_KIND]: audioJobRegistration(deps),
		},
		db: deps.db,
		normalize: normalizeAudioJobBody,
	});
	await consumer(messages);
}
