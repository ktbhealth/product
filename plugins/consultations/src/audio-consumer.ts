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
import { extractTranscriptSegments, type TranscriptSegment } from "./segments.ts";
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

/**
 * One Whisper segment — `start`/`end` in seconds plus its text.
 * Workers AI whisper models return these natively in the `ai.run`
 * response (same shape as the REST API); the pipeline.transcript
 * pack's asr-gate stage scores them for ASR error ranges.
 */
export interface WhisperSegment {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/**
 * Provider transcription result: flat text plus optional timed
 * segments. `segments` stays undefined when the provider shape carries
 * none — callers must treat that as "no timing data" and never
 * synthesize pseudo-segments (the gate degrades explicitly instead).
 */
export interface TranscriptionResult {
	readonly text: string;
	/** Timed segments when the provider returns them — `TranscriptSegment`
	 * carries the whisper `avgLogprob` confidence proxy the review-mode
	 * uncertainty markers need (PL-023). */
	readonly segments?: readonly TranscriptSegment[];
}

export interface AudioJobDeps {
	readonly db: DbClient;
	readonly bucket: AudioBucketLike | undefined;
	readonly ai: AudioTranscriber | undefined;
	/** Transcription model id — host-resolved deploy config
	 * (AUDIO_TRANSCRIBE_MODEL via the runtime registry). */
	readonly model: string;
	/** Speaker diarization (P-118): when true and `ai` is bound, the
	 * job diarizes the same audio and labels transcript segments —
	 * best-effort, failures keep them unspeaker'd. */
	readonly diarization?: boolean;
	/** Dedicated diarization backend (P-118): when the host splits ASR
	 * and diarization across endpoints (e.g. proven Whisper keeps VAD
	 * segmentation while a newer Speaches serves `/audio/diarization`),
	 * this runner takes the diarize call. Absent = `ai`. */
	readonly diarizationAi?: AudioTranscriber;
	/**
	 * LLM cleanup pass (P-017). Receives the transcript text plus the
	 * provider's timed segments when available — the
	 * consultation-transcript pipeline's asr-gate stage needs them to
	 * score ASR error ranges; `segments` is absent (never fabricated)
	 * when the provider returned none.
	 */
	readonly correctTranscript: (input: {
		readonly text: string;
		readonly segments?: readonly WhisperSegment[];
	}) => Promise<CorrectedTranscript | null>;
	/**
	 * Post-cleanup hook (PL-023): the save-time anamnesis was extracted
	 * from the raw transcript, so it goes stale the moment the LLM
	 * cleanup lands. The host regenerates it from the corrected text —
	 * skipping rows the physician already approved. Optional: hosts
	 * without an anamnesis engine omit it; failures are logged, never
	 * fatal (corrected transcript and audio status are already saved).
	 */
	readonly regenerateAnamnesis?: (consultationId: number, corrected: string) => Promise<void>;
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

/**
 * Tolerant extraction across Workers AI response shapes — flat text
 * plus optional `segments` (whisper-large-v3-turbo returns them in the
 * same payload as `text`; older/local stand-ins may return text only).
 */
export function extractWhisperResult(raw: unknown): TranscriptionResult {
	if (typeof raw === "string") return { text: raw };
	if (raw && typeof raw === "object") {
		const r = raw as Record<string, unknown>;
		const text =
			typeof r.text === "string"
				? r.text
				: typeof r.transcription === "string"
					? r.transcription
					: undefined;
		if (text === undefined) {
			throw new Error("Workers AI returned an unrecognized transcription shape");
		}
		// `extractTranscriptSegments` (segments.ts) is the tolerant decoder
		// shared with the persistence path — it also captures the whisper
		// `avg_logprob` confidence proxy (PL-023) and returns null when the
		// response carries no usable segments.
		const segments = extractTranscriptSegments(raw) ?? undefined;
		return { text, ...(segments !== undefined ? { segments } : {}) };
	}
	throw new Error("Workers AI returned an unrecognized transcription shape");
}

/** Text-only view of {@link extractWhisperResult} — kept for callers
 * that only need the flat transcript. */
export function extractWhisperText(raw: unknown): string {
	return extractWhisperResult(raw).text;
}

export async function transcribeAudio(
	transcriber: AudioTranscriber,
	audio: Uint8Array,
	model: string,
): Promise<TranscriptionResult> {
	const raw = await transcriber.run(model, whisperInputs(bytesToBase64(audio)));
	return extractWhisperResult(raw);
}

/** Diarized speaker turn (P-118): provider output shape —
 * `{start, end, speaker}` with `SPEAKER_NN` labels or matched
 * reference names. */
export interface DiarizedSegment {
	readonly start: number;
	readonly end: number;
	readonly speaker: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Tolerant extraction of a diarization response — same contract as
 * `extractTranscriptSegments`: skip malformed entries, null when
 * nothing usable arrives. */
export function extractDiarizedSegments(raw: unknown): DiarizedSegment[] | null {
	if (!raw || typeof raw !== "object") return null;
	const list = (raw as Record<string, unknown>).segments;
	if (!Array.isArray(list)) return null;
	const out: DiarizedSegment[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const s = item as Record<string, unknown>;
		const start = num(s.start);
		const end = num(s.end);
		if (start === null || end === null || typeof s.speaker !== "string" || !s.speaker) continue;
		out.push({ start, end, speaker: s.speaker });
	}
	return out.length ? out : null;
}

export function diarizeInputs(audioBase64: string) {
	return { audio: audioBase64, diarize: true };
}

/** Diarized turns below this are blips — pyannote's known <0.5s
 * false-positives (breaths, clicks, overlap). Dropped before overlap
 * matching so a noise frame never steals an ASR segment's label. */
const DIARIZATION_MIN_TURN_SEC = 0.5;

/** Speaker attribution onto ASR segments (P-118): each segment takes
 * the diarized speaker it overlaps most; sub-floor turns are filtered
 * first. Returns null when either side is empty — callers persist
 * unspeaker'd segments rather than guessing. */
export function assignSpeakers(
	segments: readonly TranscriptSegment[] | null,
	diarized: readonly DiarizedSegment[] | null,
): readonly TranscriptSegment[] | null {
	if (!segments?.length || !diarized?.length) return segments ?? null;
	const turns = diarized.filter((t) => t.end - t.start >= DIARIZATION_MIN_TURN_SEC);
	if (!turns.length) return segments;
	return segments.map((seg) => {
		let best: DiarizedSegment | null = null;
		let bestOverlap = 0;
		for (const t of turns) {
			const overlap = Math.min(seg.end, t.end) - Math.max(seg.start, t.start);
			if (overlap > bestOverlap) {
				bestOverlap = overlap;
				best = t;
			}
		}
		// No overlap at all → leave the segment unspeaker'd instead of
		// attaching the nearest voice — a wrong label is worse than none.
		return best === null ? seg : { ...seg, speaker: best.speaker };
	});
}

/** Best-effort diarization — a missing endpoint/model resolves to
 * null so the job keeps unspeaker'd segments; it never fails the
 * transcription job that produced them. */
export async function diarizeAudio(
	transcriber: AudioTranscriber,
	audio: Uint8Array,
): Promise<DiarizedSegment[] | null> {
	try {
		const raw = await transcriber.run("diarization", diarizeInputs(bytesToBase64(audio)));
		return extractDiarizedSegments(raw);
	} catch {
		return null;
	}
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
	extraDetail?: Readonly<Record<string, unknown>>,
) =>
	deps
		.recordAudit?.({
			action,
			targetType: "consultation",
			targetId: consultationId,
			tenantId,
			detail:
				extraDetail ??
				(reason === null
					? /* v8 ignore next -- every caller passes a reason or extraDetail, never neither */ null
					: { reason: coarseReason(reason) }),
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
	let result: TranscriptionResult;
	try {
		result = await transcribeAudio(deps.ai, bytes, deps.model);
	} catch (error) {
		await fail(deps, job.consultationId, `transcription failed: ${String(error)}`, tenantId);
		return;
	}
	const transcript = result.text;
	if (!transcript.trim()) {
		await fail(deps, job.consultationId, "transcription returned empty text", tenantId);
		return;
	}
	// Segment presence is part of the provider contract for whisper
	// models — surface its absence honestly (audit detail + warning)
	// instead of letting downstream stages guess at pseudo-timings.
	let segments = result.segments;
	// Speaker diarization (P-118): same audio, best-effort — nulls and
	// failures keep the segments unspeaker'd rather than failing the job.
	const diarizer = deps.diarizationAi ?? deps.ai;
	if (deps.diarization === true && diarizer !== undefined && segments != null) {
		/* v8 ignore next -- assignSpeakers only returns null for a null
		 * segment list, which the guard above already excludes. */
		segments = assignSpeakers(segments, await diarizeAudio(diarizer, bytes)) ?? segments;
	}
	if (segments === undefined) {
		console.warn("transcription provider returned no segments", {
			consultationId: job.consultationId,
			model: deps.model,
		});
	}
	// PL-023: persist the timed segments (with avgLogprob) alongside the
	// raw transcript — review-mode karaoke sync and uncertainty markers
	// read them back; ZK rows skip persistence inside completeAudioJob.
	await completeAudioJob(deps.db, job.consultationId, transcript, segments);
	await notify(deps, job.consultationId, "done", null, tenantId);
	// P-080: transcription itself is complete — audit before the
	// best-effort cleanup block below. `segments` records how many
	// timed segments the provider returned (0 = text-only response).
	await recordAudit(
		deps,
		job.consultationId,
		"consultations.transcription.completed",
		null,
		tenantId,
		{ segments: segments?.length ?? 0 },
	);

	// P-017: LLM cleanup chained in the same job. Failure leaves
	// correctedTranscript null; audioStatus stays "done".
	try {
		const corrected = await deps.correctTranscript({
			text: transcript,
			...(segments !== undefined ? { segments } : {}),
		});
		if (corrected) {
			await saveCorrectedTranscript(
				deps.db,
				job.consultationId,
				corrected.corrected,
				corrected.engine,
			);
			try {
				await deps.regenerateAnamnesis?.(job.consultationId, corrected.corrected);
			} catch (error) {
				console.warn("anamnesis regeneration failed; review can regenerate manually", {
					consultationId: job.consultationId,
					error: String(error),
				});
			}
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
		diarization: runtime.audioDiarization === true,
		diarizationAi: runtime.audioDiarizationAi as AudioTranscriber | undefined,
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
