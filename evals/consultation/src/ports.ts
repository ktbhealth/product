import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { PortError } from "@ktb/eval-core";

import type {
	AcousticProfile,
	AsrResult,
	AudioRef,
	BlobMeta,
	RunRecord,
	Sample,
	SampleOrigin,
	SampleResult,
} from "./schema.ts";

// Generic ports moved to @ktb/eval-core (P-074); the generative/
// decision ENDPOINT contracts (LlmPort, the factories and the
// Platform* services) followed so production plugins can depend on
// @ktb/eval-core instead of this evals/-workspace pack. Re-exported so
// consumers keep importing the tags from `@ktb/eval-consultation`
// directly. The Context key strings are unchanged — the orchestrator's
// ambient-port mirrors key on them.
export {
	DecisionsFactory,
	DecisionsPort,
	EvalPort,
	LlmFactory,
	LlmPort,
	PlatformDecisions,
	PlatformLlm,
	PortError,
	ReportPort,
} from "@ktb/eval-core";
export type { LlmEndpointDescriptor, LlmEndpointPreset, TaskEnvelope } from "@ktb/eval-core";

/**
 * Eval-dataset ports — hexagonal boundary. The domain pipeline
 * (pipeline.ts) talks only to these tags; adapters (eval-adapter-stub,
 * -local, -cloud) provide the layers. No platform APIs, no provider
 * literals.
 *
 * The GENERIC ports (PortError, TaskEnvelope, EvalPort, ReportPort)
 * live in @ktb/eval-core; this file keeps the transcription/consult
 * domain ports — the domain-specific half of the pack's boundary.
 */

/** Synthesize a script into audio under an acoustic profile
 * (voice + degradation are decided by the caller via profile).
 * `egress` declares whether script text may leave the perimeter —
 * hosted TTS endpoints set `true`; absent is treated as egress-capable
 * by the PHI policy (fail closed).
 *
 * WARNING — egress asymmetry: unlike AsrPort (guardAsrPort) and the
 * scrubbed LlmPort/EvalPort inputs, NOTHING structurally gates the
 * text handed to synthesize. generateDataset feeds rendered template
 * output straight in, so a caller that routes real consult text
 * through TtsPort would egress unscrubbed PHI to a hosted voice
 * endpoint. Today the only producer is the synthetic dataset
 * generator — keep it that way. TODO(phase-2): a guardTtsPort
 * mirroring guardAsrPort (scrub-or-refuse on untrusted provenance)
 * once real-audio ingest exists. */
export class TtsPort extends Context.Service<
	TtsPort,
	{
		readonly egress?: boolean;
		readonly synthesize: (input: {
			readonly script: string;
			readonly voiceId: string;
			readonly acoustic: AcousticProfile;
			/** Multi-speaker render: per-turn texts + voice aliases
			 * keyed by speaker. When present, adapters synthesize each
			 * turn with `speakerVoices[turn.speaker]` (falling back to
			 * `voiceId`) and concatenate into ONE audio. Absent =
			 * single-voice render of `script`. */
			readonly turns?: readonly { readonly speaker: string; readonly text: string }[];
			readonly speakerVoices?: Readonly<Record<string, string>>;
		}) => Effect.Effect<{ audio: AudioRef; record: RunRecord }, PortError>;
	}
>()("@ktb/eval-consultation/TtsPort") {}

/** Speech-to-text: audio ref → text + confidence-tagged segments.
 * `origin` is the CALLER-DECLARED provenance (sample manifest) — a
 * hint, not proof. `blobMeta` is the provenance recorded ON the blob
 * itself at `putBlob` time; adapters that egress audio to third
 * parties (cloud ASR) must treat stored `real_anonymized`/`unknown`
 * as non-synthetic and refuse unless explicitly opted in — voice is
 * PHI, only verified-synthetic audio may leave the perimeter.
 * `blobMeta: null` = looked up, no record; `undefined` = caller did
 * not check (the documented file:// bypass).
 *
 * `egress` is the PHI capability declaration enforced structurally by
 * `guardAsrPort` (phi.ts): `true` = audio may leave the box, `false` =
 * local-only, absent = treated as egress-capable (fail closed). Only
 * verified-`synthetic` provenance may reach an egress-capable port —
 * voice is PHI and cannot be scrubbed. */
export class AsrPort extends Context.Service<
	AsrPort,
	{
		readonly egress?: boolean;
		readonly transcribe: (
			audio: AudioRef,
			opts?: {
				readonly language?: string;
				readonly origin?: SampleOrigin;
				readonly blobMeta?: BlobMeta | null;
			},
		) => Effect.Effect<{ asr: AsrResult; record: RunRecord }, PortError>;
	}
>()("@ktb/eval-consultation/AsrPort") {}

/**
 * Cleanup gate — decides WHICH spans of an ASR transcript the
 * corrector sees (opt-in). Absent from the environment, cleanup keeps
 * the historical behavior: the whole transcript goes to
 * `LlmPort.correct`. When bound, the pipeline sends only the flagged
 * spans — measured on consult-ptbr-synthetic, whole-transcript
 * cleanup REGRESSES WER because small local models "fix" text that
 * was already correct; gating limits their blast radius.
 *
 * The decision is expressed as segment-index ranges (inclusive
 * [start, end] into `segments`, ascending) — adapters own the model
 * calls, the domain owns the segment→char-offset mapping
 * (asr-ranges.ts) so adapters never count offsets. Implementations:
 * a live System One detector (eval-adapter-local's
 * makeSystemOneCleanupGate — its own EvalPort, separate from the
 * run's judge) and a scores-file reader for precomputed decisions.
 */
export class CleanupGate extends Context.Service<
	CleanupGate,
	{
		/** Implementation name persisted on CleanupGateStats.gate. */
		readonly name: string;
		/** Score the transcript and return the segment-index ranges
		 * worth correcting (inclusive [start, end], ascending).
		 * `segments` may be empty — a segment-less transcript honestly
		 * scores zero ranges. `segmentsScored` reports how many
		 * segments the decision covered. `records` carries any
		 * model-call audit trail the decision produced — a file-backed
		 * gate emits none; the pipeline stamps one decision record
		 * regardless so the gate choice is always on the report. */
		readonly select: (input: {
			readonly sampleId: string;
			readonly text: string;
			readonly segments: readonly { readonly text: string }[];
		}) => Effect.Effect<
			{
				readonly ranges: readonly { readonly start: number; readonly end: number }[];
				readonly segmentsScored: number;
				readonly records: readonly RunRecord[];
			},
			PortError
		>;
	}
>()("@ktb/eval-consultation/CleanupGate") {}

/** Manifest rows + audio blobs. */
export class DatasetStorePort extends Context.Service<
	DatasetStorePort,
	{
		readonly putSample: (sample: Sample) => Effect.Effect<void, PortError>;
		readonly getSample: (id: string) => Effect.Effect<Sample | null, PortError>;
		readonly listSamples: (filter?: {
			readonly origin?: Sample["origin"];
			readonly datasetVersion?: string;
		}) => Effect.Effect<readonly Sample[], PortError>;
		/** `meta.origin` is persisted alongside the bytes — provenance
		 * travels WITH the blob so enforcement adapters can verify it
		 * at read/egress time. Omitting `meta` records `unknown`
		 * (conservative: cloud adapters refuse unverified audio). */
		readonly putBlob: (
			uri: string,
			bytes: Uint8Array,
			meta?: { readonly origin: SampleOrigin },
		) => Effect.Effect<void, PortError>;
		/** Record blob provenance WITHOUT writing bytes — for audio
		 * produced outside the store (TTS workDir files referenced by
		 * `file://` AudioRefs, provider-hosted URLs). Same meta contract
		 * as `putBlob`: omitted origin records `unknown`. This is what
		 * makes `getBlobMeta` answer in the real generate→transcribe
		 * flow (M1). */
		readonly putBlobMeta: (
			uri: string,
			meta?: { readonly origin: SampleOrigin },
		) => Effect.Effect<void, PortError>;
		/** Bytes for a blob written via `putBlob` — `null` when the URI
		 * has no stored object. ASYMMETRY, intentional: `putBlobMeta`
		 * registers provenance WITHOUT bytes (file:// TTS output lives
		 * outside the store), so `getBlob` returns null for those URIs
		 * even though the audio exists on disk. Callers that need bytes
		 * for non-store URIs resolve the AudioRef themselves — the
		 * cloud ASR adapter takes an injected `readAudio` for exactly
		 * this reason. */
		readonly getBlob: (uri: string) => Effect.Effect<Uint8Array | null, PortError>;
		/** Recorded provenance for a stored blob — `null` when the URI
		 * has no store record (never written, or written before
		 * provenance tracking). */
		readonly getBlobMeta: (uri: string) => Effect.Effect<BlobMeta | null, PortError>;
		/** Persisted per-sample eval outcome — the audit trail the
		 * platform exists to keep. */
		readonly putResult: (result: SampleResult) => Effect.Effect<void, PortError>;
		readonly listResults: (filter?: {
			readonly sampleId?: string;
			readonly runId?: string;
		}) => Effect.Effect<readonly SampleResult[], PortError>;
	}
>()("@ktb/eval-consultation/DatasetStorePort") {}

/** One sample an eval runner executes — the validator workflow's unit
 * (persona + rendered script + derived voices) projected from wherever
 * the caller persists them. */
export interface EvalRunnerItem {
	readonly id: number | string;
	readonly script: string;
	readonly turns?: readonly { readonly speaker: string; readonly text: string }[];
	readonly voices?: Readonly<Record<string, string>>;
	/** Demographic context handed to the anamnesis stage — mirrors the
	 * `patient` field the production extractor accepts; never evidence. */
	readonly patient?: { readonly sex?: string; readonly age?: number };
}

export interface EvalRunnerOutcome {
	readonly status: "ok" | "failed";
	readonly result?: unknown;
	readonly error?: string;
	/** Per-stage RunRecords the item produced (tts/asr/cleanup/…)
	 * — the audit trail the platform persists alongside the outcome.
	 * Absent = the driver doesn't meter calls; an empty array = it
	 * ran but emitted none. */
	readonly records?: readonly RunRecord[];
}

/**
 * Executes the transcription-eval pipeline over caller-owned items —
 * the in-app validator workflow's run step (P-081). The caller keeps
 * state (progress rows, verdicts); the port reports per-item outcomes
 * through `onSample` so progress lands durably as each sample finishes
 * rather than in one end-of-run blob. Implementations live in adapter
 * packages (local edge-tts + faster-whisper dev driver first); when no
 * driver is bound the caller leaves runs `queued`.
 */
export class EvalRunner extends Context.Service<
	EvalRunner,
	{
		readonly run: (input: {
			readonly runId: number | string;
			readonly items: readonly EvalRunnerItem[];
			readonly onSample: (id: number | string, outcome: EvalRunnerOutcome) => Effect.Effect<void>;
		}) => Effect.Effect<void>;
	}
>()("@ktb/eval-consultation/EvalRunner") {}

/**
 * Read-side for run artifacts — the bytes behind a `file://` (or
 * future `r2://`/`s3://`) AudioRef the runner produced. Kept separate
 * from DatasetStorePort: the validator workflow stores URIs in app
 * tables, not manifest blobs, so it needs "give me the audio for this
 * URI" without the dataset machinery. Implementations scope reads to
 * their artifact root — adapters MUST refuse URIs outside it.
 */
export class EvalArtifacts extends Context.Service<
	EvalArtifacts,
	{
		readonly getAudio: (uri: string) => Effect.Effect<Uint8Array | null, PortError>;
	}
>()("@ktb/eval-consultation/EvalArtifacts") {}
