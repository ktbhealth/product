import * as Effect from "effect/Effect";

import {
	makeOrchestratorRegistry,
	OrchestratorRegistryLive,
	type JsonObject,
	type KindResult,
	type NodeContext,
	type OrchestrationDef,
	type OrchestrationEvent,
	type OrchestrationKind,
	type OrchestrationPack,
	type OrchestratorRegistryService,
	type RunOptions,
} from "@ktb/orchestrator";
import type { PipelineStage, StageContext, StageResult } from "@ktb/pipeline";

import {
	CONSULTATION_TRANSCRIPT_PIPELINE,
	ENV_CORRECTOR_KEY,
	transcriptPipelinePack,
	type EnvCorrector,
} from "./pack.ts";

/**
 * orchestration.ts — `consultation-transcript` expressed as an
 * {@link OrchestrationDef} on the @ktb/orchestrator event engine
 * (P-120 phase 5, first cut).
 *
 * PARITY-BY-CONSTRUCTION: the nodes do NOT re-implement the cleanup
 * chain — each kind is a thin adapter that invokes the SAME
 * {@link PipelineStage} the `transcriptPipelinePack` registers
 * (asr-gate → llm-cleanup → env-cleanup), so port probing, degrade-to-
 * disabled paths, RunRecord audit and the env-corrector fallback are
 * literally the same code on both engines. What the orchestration adds
 * is the event wiring the editor/durable runner will consume:
 *
 *   input | start ──▶ asr-gate ──emit──▶ transcript.asr.gated
 *                                        │
 *                          llm-cleanup ◀─┘ ──emit──▶ transcript.llm.cleaned
 *                                                     │
 *                                          env-cleanup ◀─┘ ──emit──▶ transcript.env.cleaned
 *                                                                    │
 *                                              (queue drains → workflow.done)
 *
 * State parity: each kind returns the stage's `StageResult.state`
 * verbatim, so the run state accumulates the same `gate`/`cleanup`
 * fragments the pipeline registry produces, and `KindResult.output`
 * lands at `state[node.id]` with node ids equal to the stage ids —
 * the same aliasing `state[stageId]` the pipeline runner applies.
 *
 * Failure parity: a stage that fails typed is the pipeline's
 * `onError: "skip"` — the kind catches it, logs, contributes no
 * state, and STILL emits the follow-up event so the chain continues
 * ungated exactly like the sequential pack. Defects propagate
 * identically on both engines (neither runner catches them). The
 * residual divergence: the node trace records "ok" for a degraded
 * stage where the pipeline trace says "skipped" — the disabled state
 * fragments are the honest observable either way.
 *
 * KNOWN GAPS (phase-5 honest edges):
 * - `envCorrect` is a FUNCTION injected via run config. Orchestration
 *   `RunOptions.config` is nominally JsonObject — it survives the
 *   in-memory runner (runOrchestration) but NOT the durable runner,
 *   which serializes config/events to the `orchestration_*` tables.
 *   `transcriptOrchestrationConfig` carries the cast for phase 1;
 *   durable runs need a real port/kind variant (follow-up).
 * - The builtin `ai` kind is still a stub; llm-cleanup deliberately
 *   keeps using the stage's PlatformLlm port rather than the stub.
 */

/** The wire input for downstream nodes, carried on every emitted
 * event payload under `input` (the stage contract needs the ORIGINAL
 * pipeline input at every stage, not just the triggering event's
 * fragment). For the entry nodes (`input`/`start`) the payload IS the
 * wire input — `TranscriptPipelineInput` has no `input` key, so the
 * `??` fallback is unambiguous. */
const wireInputOf = (event: OrchestrationEvent): unknown =>
	(event.payload as Record<string, unknown>)["input"] ?? event.payload;

/** Build the StageContext a pack stage expects from the node context:
 * `input` is the wire input recovered from the event, `state`/`config`
 * pass through (the orchestrator's merged config IS the pipeline's
 * run config), and `params` plays the role of the def entry's
 * `stageConfig`. */
const asStageContext = (ctx: NodeContext, input: unknown): StageContext => ({
	input,
	state: ctx.state,
	config: ctx.config as Readonly<Record<string, unknown>>,
	stageConfig: ctx.params as Readonly<Record<string, unknown>>,
});

/** Invoke a pack stage with pipeline-`onError: "skip"` semantics: a
 * typed failure logs and yields null (no state contribution) instead
 * of failing the node — defects are NOT caught, matching the pipeline
 * runner which also lets them escape. */
const runPackStage = (
	stage: PipelineStage,
	ctx: NodeContext,
	input: unknown,
): Effect.Effect<StageResult | null, never, unknown> =>
	stage.run(asStageContext(ctx, input)).pipe(
		/* v8 ignore next -- defensive parity arm: every pack stage
		 * degrades internally (catch→disabled state), so a typed stage
		 * failure is unreachable today; kept so a future stage failing
		 * typed still gets the pipeline's onError:"skip" semantics. */
		Effect.catch((error) =>
			Effect.logWarning("transcript orchestration stage failed; continuing", {
				stage: stage.id,
				error: String(error),
			}).pipe(Effect.as(null)),
		),
	);

/** StageResult → KindResult with the pipeline's state aliasing: the
 * stage's `state` fragment merges into run state AND is stored at
 * `state[node.id]` (node ids equal stage ids). A skipped (null) stage
 * contributes nothing — `state[node.id]` stays absent, exactly like a
 * pipeline skip. */
const toKindResult = (result: StageResult | null): KindResult => {
	/* v8 ignore next -- result is null only via runPackStage's ignored
	 * defensive catch; the pack stages never fail typed today. */
	if (result === null) return {};
	return {
		state: result.state as JsonObject | undefined,
		output: result.output ?? result.state ?? {},
	};
};

/** Uniform follow-up payload: the wire input forwarded plus whatever
 * state fragment the stage produced (`{gate: …}` / `{cleanup: …}`)
 * spread at top level — the shape `eventSchemas` documents. */
const stageEventPayload = (input: unknown, result: StageResult | null): JsonObject => {
	/* v8 ignore next -- result?.state is nullish only on the ignored
	 * defensive skip path; the emitting kinds (asr-gate, llm-cleanup)
	 * always return a state fragment. */
	const state = result?.state ?? {};
	return {
		input: input as JsonObject,
		...(state as Record<string, unknown>),
	} as JsonObject;
};

/** Terminal event payload for env-cleanup: forwards the input and the
 * FINAL `cleanup` fragment — the env stage's own result when it
 * corrected, otherwise whatever llm-cleanup left in run state. */
const envEventPayload = (
	input: unknown,
	result: StageResult | null,
	ctx: NodeContext,
): JsonObject => {
	const cleanup = result?.state?.["cleanup"] ?? ctx.state["cleanup"];
	const payload: Record<string, unknown> = { input: input as JsonObject };
	/* v8 ignore next -- the shipped def always runs llm-cleanup
	 * upstream, which writes state.cleanup on every path; the arm is
	 * defensive for custom defs reusing this kind without it. */
	if (cleanup !== undefined) {
		payload["cleanup"] = cleanup as JsonObject;
	}
	return payload as JsonObject;
};

interface StageKindSpec {
	readonly kind: string;
	readonly stage: PipelineStage;
	readonly emit: {
		readonly type: string;
		readonly payload: (input: unknown, result: StageResult | null, ctx: NodeContext) => JsonObject;
	};
}

/** Adapt a pack {@link PipelineStage} into an {@link OrchestrationKind}:
 * recover the wire input, run the stage, merge/alias its result like
 * the pipeline runner, and emit the follow-up event — even when the
 * stage skipped, so downstream nodes fire exactly as the sequential
 * pack's later stages would. */
const stageKind = (spec: StageKindSpec): OrchestrationKind => ({
	id: spec.kind,
	run: (ctx) =>
		Effect.gen(function* () {
			const input = wireInputOf(ctx.event);
			const result = yield* runPackStage(spec.stage, ctx, input);
			const kindResult = toKindResult(result);
			return {
				...kindResult,
				events: [
					{
						type: spec.emit.type,
						payload: spec.emit.payload(input, result, ctx),
					},
				],
			};
		}),
});

/** The stage implementations — read straight off the pack so the two
 * engines can never drift (register() already proved every def entry
 * resolves). */
const asrGateStage = transcriptPipelinePack.stages["asr-gate"];
const llmCleanupStage = transcriptPipelinePack.stages["llm-cleanup"];
const envCleanupStage = transcriptPipelinePack.stages["env-cleanup"];

/** Kind ids are namespaced `transcript.*` — they are transcript-domain
 * handlers (fixed event types, fixed stage), not generic stage
 * runners. */
export const transcriptOrchestrationKinds: readonly OrchestrationKind[] = [
	stageKind({
		kind: "transcript.asr-gate",
		stage: asrGateStage,
		emit: { type: "transcript.asr.gated", payload: stageEventPayload },
	}),
	stageKind({
		kind: "transcript.llm-cleanup",
		stage: llmCleanupStage,
		emit: { type: "transcript.llm.cleaned", payload: stageEventPayload },
	}),
	stageKind({
		kind: "transcript.env-cleanup",
		stage: envCleanupStage,
		emit: { type: "transcript.env.cleaned", payload: envEventPayload },
	}),
];

/** The `consultation-transcript` orchestration def — same id as the
 * pipeline pack so cutover keeps the caller-facing name. `onNodeError:
 * "continue"` mirrors the pack's never-fail contract: a node failure
 * records `node.failed` and the run still ends "done" (the chain
 * stalls only in paths the stages' internal degrade already covers).
 * Nodes subscribe to `input` (what `runOrchestration` synthesizes for
 * a plain-object input) and `start` (bare `run(id)`), matching how the
 * pipeline accepts its input argument unconditionally. */
export const transcriptOrchestrationDef: OrchestrationDef = {
	id: CONSULTATION_TRANSCRIPT_PIPELINE,
	version: "1",
	description:
		"Consultation transcript cleanup as an event orchestration — ASR-error gating, platform-endpoint LLM correction, env-provider fallback — the OrchestrationDef twin of the consultation-transcript PipelinePack.",
	onNodeError: "continue",
	eventSchemas: [
		{
			type: "input",
			fields: { text: "string", segments: "array", taskId: "string" },
		},
		{
			type: "transcript.asr.gated",
			fields: { input: "object", gate: "object" },
		},
		{
			type: "transcript.llm.cleaned",
			fields: { input: "object", cleanup: "object" },
		},
		{
			type: "transcript.env.cleaned",
			fields: { input: "object", cleanup: "object" },
		},
	],
	nodes: [
		{
			id: "asr-gate",
			kind: "transcript.asr-gate",
			on: ["input", "start"],
			emits: ["transcript.asr.gated"],
		},
		{
			id: "llm-cleanup",
			kind: "transcript.llm-cleanup",
			on: ["transcript.asr.gated"],
			emits: ["transcript.llm.cleaned"],
		},
		{
			id: "env-cleanup",
			kind: "transcript.env-cleanup",
			on: ["transcript.llm.cleaned"],
			emits: ["transcript.env.cleaned"],
		},
	],
};

/** The orchestration analog of a {@link PipelinePack}: def (data) +
 * kind handlers (code) — the shared {@link OrchestrationPack} shape
 * the plugin manifest's `orchestrations` field carries (PluginBase,
 * @ktb/kernel). The alias keeps the transcript-local name for the
 * tests/docs that reference it. */
export type TranscriptOrchestrationPack = OrchestrationPack;

export const transcriptOrchestrationPack: TranscriptOrchestrationPack = {
	def: transcriptOrchestrationDef,
	kinds: transcriptOrchestrationKinds,
};

/** Standalone registry with the transcript kinds pre-registered and
 * the def registered — the `makePipelineRegistry` + `register(pack)`
 * test/composition pattern, one call. `extraKinds` lets a composition
 * root add domain kinds (e.g. builtin emit/gate) before registering
 * additional defs itself. */
export const makeTranscriptOrchestratorRegistry = (
	extraKinds: readonly OrchestrationKind[] = [],
): OrchestratorRegistryService => {
	const registry = makeOrchestratorRegistry([...extraKinds, ...transcriptOrchestrationKinds]);
	registry.registerDef(transcriptOrchestrationDef);
	return registry;
};

/** `OrchestratorRegistryLive` over this pack — the standalone
 * composition-root entry point mirroring `pipelineRegistryLive`.
 * app-host's shared registry is built by `orchestratorRegistryLive
 * (plugins)` (@ktb/plugin-pipeline) from the manifest's
 * `orchestrations` field; this helper remains for tests and
 * one-off compositions that want ONLY the transcript kinds. */
export const transcriptOrchestratorRegistryLive = (
	extraKinds: readonly OrchestrationKind[] = [],
	extraDefs: readonly OrchestrationDef[] = [],
) =>
	OrchestratorRegistryLive(
		[...extraKinds, ...transcriptOrchestrationKinds],
		[transcriptOrchestrationDef, ...extraDefs],
	);

/** Run-config builder for the env-cleanup fallback: the composition
 * root's env corrector rides `RunOptions.config` under the same
 * {@link ENV_CORRECTOR_KEY} the pipeline pack reads. The `as unknown as
 * JsonObject` cast is the documented phase-1 edge — functions survive
 * the in-memory runner but cannot serialize through the durable
 * runner's snapshot/event persistence; a durable-safe corrector needs
 * a port or a kind variant (follow-up, see module doc). */
export const transcriptOrchestrationConfig = (envCorrect?: EnvCorrector): JsonObject =>
	envCorrect === undefined ? {} : ({ [ENV_CORRECTOR_KEY]: envCorrect } as unknown as JsonObject);

/** Convenience runner mirroring `PipelineRegistry.run(id, input,
 * config)` ergonomics for callers that don't hold a registry: builds
 * a fresh registry per call (fine for tests/one-shots; production
 * cutover should resolve the ambient OrchestratorRegistry service
 * once, like PipelineRegistry today). `config` is the RAW run config
 * (same shape as the pipeline's third argument) — wrap env correctors
 * with {@link transcriptOrchestrationConfig} first. */
export const runTranscriptOrchestration = (
	input: unknown,
	config?: Readonly<Record<string, unknown>>,
	opts?: Omit<RunOptions, "config">,
) =>
	makeTranscriptOrchestratorRegistry().run(CONSULTATION_TRANSCRIPT_PIPELINE, input, {
		...opts,
		config: config as JsonObject | undefined,
	});
