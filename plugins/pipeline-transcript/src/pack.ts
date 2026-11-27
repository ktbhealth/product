import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Layer from "effect/Layer";

import type { PipelinePack, PipelineStage, StageContext, StageResult } from "@ktb/pipeline";
import {
	DecisionsPort,
	LlmPort,
	PlatformDecisions,
	PlatformLlm,
	type EditList,
	type PortError,
	type RunRecord,
} from "@ktb/eval-core";
import {
	charRangesFor,
	cleanupTranscript,
	cleanupTranscriptGated,
	detectAsrErrorRanges,
	segmentCharSpans,
	type AsrRange,
} from "@ktb/transcript-cleanup";

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
 *   env-cleanup   — env-derived providers bound by the composition
 *                   root as the ambient {@link EnvCorrector} port
 *                   (durable-safe; the legacy run-config `envCorrect`
 *                   function remains as in-memory back-compat): the
 *                   free-text path, run ONLY when llm-cleanup produced
 *                   nothing. This is the pipeline's own fallback —
 *                   callers never chain providers outside the def.
 *
 * Every stage degrades gracefully (`onError: "skip"` plus internal
 * catch→disabled): the pipeline NEVER fails a transcript cleanup —
 * worst case every stage lands disabled and the caller stores null.
 *
 * Port resolution mirrors @ktb/eval-core's `preferringLlmPortLive`:
 * `Effect.serviceOption` probes the plugin capability, `defaultLayer()`
 * resolves the platform-default endpoint per call (admin changes apply
 * without restart), `Effect.provide(layer)` binds the concrete port for
 * the domain functions, and every failure degrades to null/disabled.
 * (Anamnesis extraction routes through the same precedence inside the
 * port itself — see packages/anamnesis-llm.)
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

/** Env-corrector result — the legacy free-text correction plus the
 * provider tag recorded as `state.cleanup.engine`. */
export interface EnvCorrectorResult {
	readonly corrected: string;
	readonly engine: string;
}

/** Env-corrector contract — the corrector function shape shared by
 * the two injection paths: {@link EnvCorrectorFn} values ride run
 * config under {@link ENV_CORRECTOR_KEY} (in-memory back-compat) and
 * as the {@link EnvCorrector} ambient port's `correct` member (the
 * durable-safe path — live functions cannot serialize through the
 * durable runner's snapshot/event persistence). Plugins cannot import
 * adapter packages (arch lint) or read env, so the composition root
 * supplies a ready corrector: app-host wires `anamnesis-llm`'s
 * `correctTranscript(llmConfig, text)` here. Returns null on
 * unconfigured/failure, mirroring CorrectedTranscript; typed failures
 * are caught by the stage like every other corrector error. */
export type EnvCorrectorFn = (
	text: string,
) => Effect.Effect<EnvCorrectorResult | null, unknown, unknown>;

/** Ambient env-corrector port — the durable-safe successor of the
 * `envCorrect` run-config function. Declared here (not in
 * @ktb/orchestrator's ambient vocabulary) because the corrector is
 * transcript-domain: only this pack's env-cleanup stage probes it, and
 * the pack already owns the ENV_CORRECTOR_KEY contract. The stage
 * probes it with `Effect.serviceOption` — the same ambient-port idiom
 * the PlatformLlm/PlatformDecisions probes above use — so BOTH engines
 * (PipelineRegistry and the OrchestrationDef kinds, which invoke this
 * same stage) and BOTH runners (in-memory `registry.run` inheriting
 * the caller's context, durable steps via the runner's
 * `ambientContext`) resolve it identically. Precedence inside
 * env-cleanup: ambient port → run-config `envCorrect` function →
 * degrade (`{skipped: true}` output, no cleanup state). */
export class EnvCorrector extends Context.Service<
	EnvCorrector,
	{ readonly correct: EnvCorrectorFn }
>()("@ktb/plugin-pipeline-transcript/EnvCorrector") {}

/** Run-config key carrying the composition root's env corrector into
 * the env-cleanup stage: `registry.run(id, input, { envCorrect })`.
 * In-memory back-compat only — functions cannot serialize through the
 * durable runner; durable runs bind {@link EnvCorrector} instead. */
export const ENV_CORRECTOR_KEY = "envCorrect";

/** `defaultLayer()` declares R=unknown because the plugin impl may
 * read credentials bound by composition — same erasure
 * @ktb/eval-core's preferring-llm documents; tests stub the Platform*
 * services anyway. */
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
 * (anthropic > openai > workers-ai, resolved by the composition root)
 * produce the legacy free-text correction. The corrector resolves in
 * precedence order: the ambient {@link EnvCorrector} port first (the
 * durable-safe path — live services reach the stage through the
 * caller's Effect context on every engine/runner), then the run-config
 * `envCorrect` function (in-memory back-compat), else the stage
 * degrades to a `{skipped: true}` output. Runs only when llm-cleanup
 * left `cleanup.enabled !== true` — platform endpoints always win,
 * env is the floor. Free-text (not EditList): ungated by design, it is
 * the pre-pipeline behavior preserved as a configured stage, not a
 * caller-side chain. Corrector failures write nothing — `state.cleanup`
 * keeps whatever llm-cleanup left. */
const envCleanupStage: PipelineStage = {
	id: "env-cleanup",
	description:
		"Env-provider transcript cleanup (EnvCorrector port, envCorrect run-config fallback) — runs when no platform endpoint corrected the transcript.",
	run: (ctx: StageContext) =>
		Effect.gen(function* () {
			const cleanup = ctx.state.cleanup as TranscriptCleanupState | undefined;
			if (cleanup?.enabled === true && typeof cleanup.corrected === "string") return {};
			const input = asInput(ctx.input);
			if (input === null || input.text.trim() === "") return {};

			// Ambient port wins over the run-config function — the port
			// is the only binding that survives the durable runner's
			// serialized snapshots, so preferring it keeps in-memory and
			// durable runs on the same corrector when both are bound.
			const portOpt = yield* Effect.serviceOption(EnvCorrector);
			const configured = (ctx.config as Record<string, unknown> | undefined)?.[
				ENV_CORRECTOR_KEY
			] as EnvCorrectorFn | undefined;
			const correct: EnvCorrectorFn | undefined = Option.isSome(portOpt)
				? portOpt.value.correct
				: typeof configured === "function"
					? configured
					: undefined;
			if (correct === undefined) {
				// Same degrade shape the builtin `ai` kind uses for a
				// missing port — observable in state["env-cleanup"],
				// never a run failure.
				return { output: { skipped: true, reason: "no-port" } };
			}

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
