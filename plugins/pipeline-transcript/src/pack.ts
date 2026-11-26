import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Layer from "effect/Layer";

import type { PipelinePack, PipelineStage, StageContext, StageResult } from "@ktb/pipeline";
import {
	charRangesFor,
	cleanupTranscript,
	cleanupTranscriptGated,
	DecisionsPort,
	detectAsrErrorRanges,
	LlmPort,
	PlatformDecisions,
	PlatformLlm,
	segmentCharSpans,
	type AsrRange,
	type EditList,
	type PortError,
	type RunRecord,
} from "@ktb/eval-consultation";

/**
 * pack.ts — the `consultation-transcript` pipeline pack: contract
 * constants, wire/state types, the three stage implementations and
 * the {@link transcriptPipelinePack} itself. Leaf module — BOTH
 * ./index.ts (plugin manifest) and ./orchestration.ts (the
 * OrchestrationDef twin) import from here, so neither can create an
 * import cycle: the manifest contributes the orchestration pack, and
 * the orchestration kinds invoke these exact stage impls.
 *
 * Composes the consultation domain's cleanup chain as a generic
 * @ktb/pipeline DAG so production surfaces (app-host's
 * `correctTranscript`) and eval drivers (makeEvalRunner) run the SAME
 * stages instead of re-implementing the port-probing dance:
 *
 *   asr-gate      — PlatformDecisions (systemone endpoint) scores each
 *                   transcript segment for ASR errors and maps the
 *                   flagged segment-index ranges to char spans the
 *                   corrector can be scoped to. Absent endpoint →
 *                   `gate.enabled = false`.
 *   llm-cleanup   — PlatformLlm (generative endpoint) corrects the
 *                   transcript: `cleanupTranscriptGated` over the gate's
 *                   char ranges when any were flagged, the historical
 *                   whole-transcript `cleanupTranscript` otherwise.
 *                   Absent endpoint → `cleanup.enabled = false`.
 *   env-cleanup   — env-derived providers injected by the composition
 *                   root as run config `envCorrect` (a corrector
 *                   function): the legacy free-text path, run ONLY when
 *                   llm-cleanup produced nothing. This is the
 *                   pipeline's own fallback — callers never chain
 *                   providers outside the def.
 *
 * Every stage degrades gracefully (`onError: "skip"` plus internal
 * catch→disabled): the pipeline NEVER fails a transcript cleanup —
 * worst case every stage lands disabled and the caller stores null.
 *
 * Port resolution mirrors packages/app-host/src/platform-llm.ts:
 * `Effect.serviceOption` probes the plugin capability, `defaultLayer()`
 * resolves the platform-default endpoint per call (admin changes apply
 * without restart), `Effect.provide(layer)` binds the concrete port for
 * the domain functions, and every failure degrades to null/disabled.
 */

/** Pipeline id — the contract app-host and eval drivers run by name. */
export const CONSULTATION_TRANSCRIPT_PIPELINE = "consultation-transcript";

/** Wire input contract: the raw transcript text, optional ASR
 * segments (their `.text` fields locate char spans), and an optional
 * taskId namespacing corrector calls for audit. */
export interface TranscriptPipelineInput {
	readonly text: string;
	readonly segments?: readonly { readonly text: string }[];
	readonly taskId?: string;
}

/** `state.gate` written by the asr-gate stage. `ranges` are CHAR spans
 * (already mapped from segment indices via segmentCharSpans +
 * charRangesFor) — sorted, non-overlapping, ready for
 * cleanupTranscriptGated. */
export interface TranscriptGateState {
	readonly enabled: boolean;
	readonly ranges?: readonly AsrRange[];
	readonly records?: readonly RunRecord[];
	readonly error?: string;
}

/** `state.cleanup` written by the llm-cleanup stage — the shape
 * consumers (app-host, makeEvalRunner) branch on. `enabled: false`
 * means "no platform LLM endpoint" and the caller must fall back. */
export interface TranscriptCleanupState {
	readonly enabled: boolean;
	readonly corrected?: string;
	readonly edits?: number;
	readonly engine?: string;
	readonly records?: readonly RunRecord[];
	readonly error?: string;
}

/** Narrow the unknown `ctx.input` to the wire contract — a malformed
 * input disables both stages rather than failing the run. */
const asInput = (input: unknown): TranscriptPipelineInput | null => {
	if (typeof input !== "object" || input === null) return null;
	const raw = input as {
		readonly text?: unknown;
		readonly segments?: unknown;
		readonly taskId?: unknown;
	};
	if (typeof raw.text !== "string") return null;
	const segments = Array.isArray(raw.segments)
		? raw.segments.filter(
				(s): s is { readonly text: string } =>
					typeof s === "object" && s !== null && typeof (s as { text?: unknown }).text === "string",
			)
		: undefined;
	return {
		text: raw.text,
		...(segments !== undefined ? { segments } : {}),
		...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
	};
};

/** Env-corrector contract injected as run config — plugins cannot
 * import adapter packages (arch lint) or read env, so the composition
 * root supplies a ready corrector: app-host wires
 * `anamnesis-llm`'s `correctTranscript(llmConfig, text)` here. Returns
 * null on unconfigured/failure, mirroring CorrectedTranscript. */
export type EnvCorrector = (
	text: string,
) => Effect.Effect<{ readonly corrected: string; readonly engine: string } | null>;

/** Run-config key carrying the composition root's env corrector into
 * the env-cleanup stage: `registry.run(id, input, { envCorrect })`. */
export const ENV_CORRECTOR_KEY = "envCorrect";

/** `defaultLayer()` declares R=unknown because the plugin impl may
 * read credentials bound by composition — same erasure platform-llm.ts
 * documents; tests stub the Platform* services anyway. */
const decisionsLayer = (
	platform: PlatformDecisions["Service"],
): Effect.Effect<Layer.Layer<DecisionsPort> | null> =>
	(platform.defaultLayer() as Effect.Effect<Layer.Layer<DecisionsPort> | null>).pipe(
		Effect.catch(() => Effect.succeed(null)),
		Effect.catchDefect(() => Effect.succeed(null)),
	);

const llmLayer = (platform: PlatformLlm["Service"]): Effect.Effect<Layer.Layer<LlmPort> | null> =>
	(platform.defaultLayer() as Effect.Effect<Layer.Layer<LlmPort> | null>).pipe(
		Effect.catch(() => Effect.succeed(null)),
		Effect.catchDefect(() => Effect.succeed(null)),
	);

const gateDisabled = (error?: string): StageResult => ({
	state: { gate: { enabled: false, ...(error === undefined ? {} : { error }) } },
});

const cleanupDisabled = (error?: string): StageResult => ({
	state: { cleanup: { enabled: false, ...(error === undefined ? {} : { error }) } },
});

/** asr-gate — score segments for ASR errors via the platform-default
 * DECISION endpoint and publish the flagged char ranges for
 * llm-cleanup. Every absence/failure path lands on
 * `gate.enabled = false` (ungated cleanup downstream). */
const asrGateStage: PipelineStage = {
	id: "asr-gate",
	description:
		"Detect ASR error ranges with the platform decision endpoint; publishes char-span ranges for the cleanup stage.",
	run: (ctx: StageContext) =>
		Effect.gen(function* () {
			const platformOpt = yield* Effect.serviceOption(PlatformDecisions);
			if (Option.isNone(platformOpt)) return gateDisabled();
			const layer = yield* decisionsLayer(platformOpt.value);
			if (layer === null) return gateDisabled();
			const input = asInput(ctx.input);
			if (input === null) return gateDisabled("invalid-input");

			// Real ASR segments are REQUIRED — timestamps are the gate's
			// input contract, and synthesizing pseudo-segments from flat
			// text would silently degrade range precision. A text-only
			// provider is an infra gap the caller surfaces (warn + audit
			// count upstream), so the gate disables honestly instead.
			const segments = input.segments;
			if (segments === undefined || segments.length === 0) {
				return gateDisabled("no-segments");
			}
			const detected = yield* detectAsrErrorRanges(segments, { lang: "pt" }).pipe(
				Effect.provide(layer),
				Effect.catch((error) =>
					Effect.logWarning("asr-gate detection failed", { error: String(error) }).pipe(
						Effect.as(null),
					),
				),
				Effect.catchDefect((defect) =>
					Effect.logWarning("asr-gate detection failed", { error: String(defect) }).pipe(
						Effect.as(null),
					),
				),
			);
			if (detected === null) return gateDisabled("detection-failed");

			// Segment-index ranges → char spans over the full transcript:
			// detectAsrErrorRanges only knows segment positions, and
			// cleanupTranscriptGated needs char offsets. segmentCharSpans
			// re-locates each segment's text by forward indexOf — real
			// Whisper segments are verbatim substrings of `text` in
			// order, so the scan always lands on the right occurrence.
			const spans = segmentCharSpans(input.text, segments);
			const ranges = charRangesFor(detected.ranges, spans);
			return {
				state: {
					gate: {
						enabled: true,
						ranges,
						records: detected.records,
					},
				} satisfies { gate: TranscriptGateState },
			};
		}),
};

/** llm-cleanup — correct the transcript through the platform-default
 * GENERATIVE endpoint. Gated (per-range `correct` calls) when asr-gate
 * published char ranges, whole-transcript otherwise. Every
 * absence/failure path lands on `cleanup.enabled = false`. */
const llmCleanupStage: PipelineStage = {
	id: "llm-cleanup",
	description:
		"Correct the transcript via the platform LLM endpoint — gated to flagged ASR-error ranges when the asr-gate stage produced them.",
	run: (ctx: StageContext) =>
		Effect.gen(function* () {
			const platformOpt = yield* Effect.serviceOption(PlatformLlm);
			if (Option.isNone(platformOpt)) return cleanupDisabled();
			const layer = yield* llmLayer(platformOpt.value);
			if (layer === null) return cleanupDisabled();
			const input = asInput(ctx.input);
			if (input === null || input.text.trim() === "") return cleanupDisabled("invalid-input");

			const gate = ctx.state.gate as TranscriptGateState | undefined;
			const ranges = gate?.enabled === true && Array.isArray(gate.ranges) ? gate.ranges : [];
			const taskId = input.taskId ?? "transcript-cleanup";
			// Both variants report through onRecord (the gated one once per
			// range); the last record carries the engine identity. The two
			// gen effects have different success shapes, so they are mapped
			// to one Effect type up front — a raw union defeats
			// Effect.provide's single-signature overload.
			const records: RunRecord[] = [];
			const onRecord = (r: RunRecord) => {
				records.push(r);
			};
			const correctFx: Effect.Effect<{ corrected: string; edits: EditList }, PortError, LlmPort> =
				ranges.length > 0
					? cleanupTranscriptGated({ taskId, raw: input.text, ranges, onRecord }).pipe(
							Effect.map((r) => ({ corrected: r.corrected, edits: r.edits })),
						)
					: cleanupTranscript({ taskId, raw: input.text, onRecord }).pipe(
							Effect.map((r) => ({ corrected: r.corrected, edits: r.edits })),
						);
			const corrected = yield* correctFx.pipe(
				Effect.provide(layer),
				Effect.catch((error) =>
					Effect.logWarning("pipeline transcript cleanup failed", {
						error: String(error),
					}).pipe(Effect.as(null)),
				),
				Effect.catchDefect((defect) =>
					Effect.logWarning("pipeline transcript cleanup failed", {
						error: String(defect),
					}).pipe(Effect.as(null)),
				),
			);
			if (corrected === null) return cleanupDisabled("cleanup-failed");

			return {
				state: {
					cleanup: {
						enabled: true,
						corrected: corrected.corrected,
						edits: corrected.edits.ops.length,
						engine: records.at(-1)?.engine ?? "unknown",
						records,
					},
				} satisfies { cleanup: TranscriptCleanupState },
			};
		}),
};

/** env-cleanup — the pipeline's OWN fallback: env-derived providers
 * (anthropic > openai > workers-ai, resolved by the composition root
 * and injected as run config `envCorrect`) produce the legacy
 * free-text correction. Runs only when llm-cleanup left
 * `cleanup.enabled !== true` — platform endpoints always win, env is
 * the floor. Free-text (not EditList): ungated by design, it is the
 * pre-pipeline behavior preserved as a configured stage, not a
 * caller-side chain. Every absence/failure path writes nothing —
 * `state.cleanup` keeps whatever llm-cleanup left. */
const envCleanupStage: PipelineStage = {
	id: "env-cleanup",
	description:
		"Env-provider transcript cleanup (corrector fn via run config) — fallback when no platform endpoint corrected the transcript.",
	run: (ctx: StageContext) =>
		Effect.gen(function* () {
			const cleanup = ctx.state.cleanup as TranscriptCleanupState | undefined;
			if (cleanup?.enabled === true && typeof cleanup.corrected === "string") return {};
			const correct = (ctx.config as Record<string, unknown> | undefined)?.[ENV_CORRECTOR_KEY] as
				| EnvCorrector
				| undefined;
			if (typeof correct !== "function") return {};
			const input = asInput(ctx.input);
			if (input === null || input.text.trim() === "") return {};

			const corrected = yield* correct(input.text).pipe(
				Effect.catch((error) =>
					Effect.logWarning("env transcript cleanup failed", {
						error: String(error),
					}).pipe(Effect.as(null)),
				),
				Effect.catchDefect((defect) =>
					Effect.logWarning("env transcript cleanup failed", {
						error: String(defect),
					}).pipe(Effect.as(null)),
				),
			);
			if (corrected === null) return {};

			return {
				state: {
					cleanup: {
						enabled: true,
						corrected: corrected.corrected,
						engine: corrected.engine,
					},
				} satisfies { cleanup: TranscriptCleanupState },
			};
		}),
};

/** The `consultation-transcript` pack: gate → platform cleanup → env
 * cleanup, every stage `onError: "skip"` so a stage defect records a
 * skipped trace entry and the run continues — combined with the
 * internal degrade-to-disabled paths above, the pipeline can only
 * ever produce disabled state or a real cleanup result, never a
 * failed run. */
export const transcriptPipelinePack: PipelinePack = {
	def: {
		id: CONSULTATION_TRANSCRIPT_PIPELINE,
		version: "1",
		description:
			"ASR-error gating (platform decision endpoint), platform-endpoint LLM cleanup (reversible edits), env-provider cleanup fallback.",
		stages: [
			{ id: "asr-gate", onError: "skip" },
			{ id: "llm-cleanup", onError: "skip" },
			{ id: "env-cleanup", onError: "skip" },
		],
	},
	stages: {
		"asr-gate": asrGateStage,
		"llm-cleanup": llmCleanupStage,
		"env-cleanup": envCleanupStage,
	},
};
