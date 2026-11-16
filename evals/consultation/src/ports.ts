import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

import type { PortError, TaskEnvelope } from "@ktb/eval-core";

import type {
	AcousticProfile,
	AsrResult,
	AudioRef,
	BlobMeta,
	EditList,
	RunRecord,
	Sample,
	SampleOrigin,
	SampleResult,
} from "./schema.ts";

// Generic ports moved to @ktb/eval-core (P-074) — re-exported so
// consumers import the tags from `@ktb/eval-consultation` directly.
export { EvalPort, PortError, ReportPort } from "@ktb/eval-core";
export type { TaskEnvelope } from "@ktb/eval-core";

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

/** Generative model port — ACP-delegated in live adapters.
 * `egress` declares whether envelope input text may leave the
 * perimeter (remote agent vs in-process); the pipeline only ever sends
 * scrubbed text, so this is informational today — declared for the
 * same structural policy as the other ports. */
export class LlmPort extends Context.Service<
	LlmPort,
	{
		readonly egress?: boolean;
		readonly generate: (
			envelope: TaskEnvelope,
		) => Effect.Effect<{ text: string; record: RunRecord }, PortError>;
		/** Surface correction: returns a reversible edit list, never a
		 * rewritten blob — edits stay auditable/rollback-able. */
		readonly correct: (
			envelope: TaskEnvelope,
		) => Effect.Effect<{ edits: EditList; record: RunRecord }, PortError>;
	}
>()("@ktb/eval-consultation/LlmPort") {}

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

/** Provider descriptor for a generative endpoint — the rows the eval
 * lab's endpoint CRUD persists. `kind` selects the wire protocol:
 * `acp` = JSON-RPC agent transport (Claude Code, Gemini CLI, custom
 * agents); `openai` = OpenAI-compatible chat completions (Ollama, LM
 * Studio, GPT, Gemini's compat endpoint). `secretRef` is the NAME of
 * an env var holding the API key — keys never live in tables. */
export interface LlmEndpointDescriptor {
	readonly kind: "acp" | "openai";
	readonly baseUrl: string;
	readonly model?: string;
	readonly sessionId?: string;
	readonly secretRef?: string;
	/** ACP transport — `ws` is the HTTP/WebSocket path adapters in this
	 * runtime support; `child`/`ssh` require a Node-runtime driver and
	 * resolve to a PortError under workerd. Absent = `ws`. */
	readonly transport?: "ws" | "child" | "ssh";
	/** Raw API key resolved server-side (e.g. from the credentials
	 * store) — never persisted on the endpoint row. */
	readonly apiKey?: string;
	readonly timeoutMs?: number;
}

/** A starter endpoint for the eval lab's endpoint form — surfaced by
 * the bound adapter so provider endpoints stay in the exempt edge
 * (arch-policy bans provider literals in port/domain code). `label`
 * is the UI-facing chip name; the rest pre-fills the form fields. */
export interface LlmEndpointPreset {
	readonly label: string;
	readonly kind: LlmEndpointDescriptor["kind"];
	readonly baseUrl: string;
	readonly model?: string;
}

/** Factory port — resolves an endpoint descriptor into a bound
 * LlmPort layer on demand. Lives next to the other eval ports so
 * plugins (eval lab) can build per-endpoint generators without
 * importing adapters: the composition root binds one factory and the
 * plugin asks it for concrete ports. `test` is a liveness ping used
 * by the endpoint CRUD's "test connection" action. `presets` is the
 * adapter's list of provider starter endpoints the endpoint dialog
 * offers as one-click chips — optional since adapters may know no
 * hosted providers. */
export class LlmFactory extends Context.Service<
	LlmFactory,
	{
		readonly resolve: (
			descriptor: LlmEndpointDescriptor,
		) => Effect.Effect<Layer.Layer<LlmPort>, PortError>;
		readonly test: (descriptor: LlmEndpointDescriptor) => Effect.Effect<void, PortError>;
		readonly presets?: readonly LlmEndpointPreset[];
	}
>()("@ktb/eval-consultation/LlmFactory") {}

/**
 * Platform-default generative endpoint for PRODUCTION surfaces
 * (transcript cleanup, anamnesis extraction) — bound by the
 * ai-endpoints plugin's services layer. `defaultLayer` resolves the
 * enabled `scope='platform'` `is_default` endpoint through LlmFactory
 * on every call, so admin changes apply without a restart; `null`
 * means "no platform default configured" and consumers fall back to
 * env-derived provider config, then their deterministic path. Absent
 * service (plugin not registered) is the same fallback — read it via
 * `Effect.serviceOption`.
 */
export class PlatformLlm extends Context.Service<
	PlatformLlm,
	{
		readonly defaultLayer: () => Effect.Effect<Layer.Layer<LlmPort> | null, never, unknown>;
	}
>()("@ktb/eval-consultation/PlatformLlm") {}
