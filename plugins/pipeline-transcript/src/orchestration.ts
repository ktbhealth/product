import type { JsonObject } from "effect/Schema";

import {
	makeOrchestratorRegistry,
	OrchestratorRegistryLive,
	type OrchestrationDef,
	type OrchestrationKind,
	type OrchestrationPack,
	type OrchestratorRegistryService,
	type RunOptions,
} from "@ktb/orchestrator";
import { pipelinePackToOrchestration } from "@ktb/pipeline";

import {
	CONSULTATION_TRANSCRIPT_PIPELINE,
	ENV_CORRECTOR_KEY,
	transcriptPipelinePack,
	type EnvCorrectorFn,
} from "./pack.ts";

/**
 * orchestration.ts — `consultation-transcript` expressed as an
 * {@link OrchestrationDef} on the @ktb/orchestrator event engine
 * (P-120 phase 5). The def+kinds are DERIVED, not hand-written:
 * {@link pipelinePackToOrchestration} (@ktb/pipeline) is the canonical
 * PipelineDef → OrchestrationDef translation, so the orchestration
 * invokes the SAME {@link PipelineStage} implementations the
 * `transcriptPipelinePack` registers — port probing, degrade-to-
 * disabled paths, RunRecord audit and the env-corrector fallback are
 * literally the same code on both engines, and there is no adapter
 * layer here to drift.
 *
 * Derived wiring (see @ktb/pipeline bridge.ts for the full contract):
 *
 *   input | start ──▶ asr-gate ──emit──▶ consultation-transcript.asr-gate.done
 *                                        │
 *                          llm-cleanup ◀─┘ ──emit──▶ consultation-transcript.llm-cleanup.done
 *                                                          │
 *                                               env-cleanup ◀─┘ ──emit──▶ consultation-transcript.env-cleanup.done
 *                                                                     │
 *                                                 (queue drains → workflow.done)
 *
 * State parity: each adapted kind returns the stage's `StageResult`
 * with the pipeline's aliasing (`state[stageId] = output ?? state ??
 * {}` — node ids equal stage ids), so the run state accumulates the
 * same `gate`/`cleanup` fragments and per-stage aliases the pipeline
 * registry produces.
 *
 * Failure parity: every def entry is `onError: "skip"`, which the
 * adapter enforces INSIDE the kind — a typed stage failure logs,
 * contributes no state, and STILL emits the follow-up event so the
 * chain continues ungated exactly like the sequential pack (a failed
 * orchestrator node would emit nothing and stall the chain). Defects
 * propagate identically on both engines. Residual divergences are the
 * documented bridge edges: the node trace records "ok" for a degraded
 * stage where the pipeline trace says "skipped", `onNodeError` is
 * "halt" (moot — skip-kind failures never reach node level), and the
 * env-cleanup terminal event carries only the input + its own state
 * fragment (the old hand-rolled payload also echoed the upstream
 * `cleanup` fragment — cosmetic, the run state is authoritative).
 *
 * KNOWN GAPS (phase-5 honest edges):
 * - `envCorrect` is a FUNCTION injected via run config. Orchestration
 *   `RunOptions.config` is nominally JsonObject — it survives the
 *   in-memory runner (runOrchestration) but NOT the durable runner,
 *   which serializes config/events to the `orchestration_*` tables.
 *   The durable-safe path is the ambient {@link EnvCorrector} port
 *   (pack.ts): env-cleanup probes it via `Effect.serviceOption` —
 *   port → config function → `{skipped: true}` degrade — so durable
 *   steps resolve the corrector from the runner's `ambientContext`,
 *   never from serialized config. `transcriptOrchestrationConfig`
 *   keeps working for in-memory callers as the config-function
 *   fallback.
 * - The `ai` orchestration kind lives in @ktb/orchestrator-ai (contributed
 *   by ai.provider.services' pack); llm-cleanup deliberately keeps using
 *   the stage's PlatformLlm port rather than routing through it.
 */

/** The orchestration analog of a {@link PipelinePack}: def (data) +
 * kind handlers (code) — the shared {@link OrchestrationPack} shape
 * the plugin manifest's `orchestrations` field carries (PluginBase,
 * @ktb/kernel). Derived by {@link pipelinePackToOrchestration} from
 * `transcriptPipelinePack`, so def id/version/description and the
 * stage order can never drift from the pipeline def. */
export type TranscriptOrchestrationPack = OrchestrationPack;

/** Event-schema documentation layered onto the derived def — the
 * bridge produces the wiring; the wire shapes are transcript-domain
 * knowledge that stays here. Payloads follow the bridge convention:
 * every chained event carries the original pipeline input under
 * `input` plus the stage's state fragment (`gate`/`cleanup`) spread at
 * top level. */
const TRANSCRIPT_EVENT_SCHEMAS = [
	{
		type: "input",
		fields: { text: "string", segments: "array", taskId: "string" },
	},
	{
		type: "consultation-transcript.asr-gate.done",
		fields: { input: "object", gate: "object" },
	},
	{
		type: "consultation-transcript.llm-cleanup.done",
		fields: { input: "object", cleanup: "object" },
	},
	{
		type: "consultation-transcript.env-cleanup.done",
		fields: { input: "object", cleanup: "object" },
	},
] as const;

const derivedPack = pipelinePackToOrchestration(transcriptPipelinePack);

export const transcriptOrchestrationPack: TranscriptOrchestrationPack = {
	...derivedPack,
	def: { ...derivedPack.def, eventSchemas: [...TRANSCRIPT_EVENT_SCHEMAS] },
};

export const transcriptOrchestrationDef: OrchestrationDef = transcriptOrchestrationPack.def;

export const transcriptOrchestrationKinds: readonly OrchestrationKind[] =
	transcriptOrchestrationPack.kinds;

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
 * JsonObject` cast is the documented edge — functions survive the
 * in-memory runner but cannot serialize through the durable runner's
 * snapshot/event persistence (the function is silently dropped by
 * JSON). Durable-safe callers bind the ambient {@link EnvCorrector}
 * port instead (see pack.ts); this helper remains the in-memory
 * config-function fallback — env-cleanup prefers the port when both
 * are present. */
export const transcriptOrchestrationConfig = (envCorrect?: EnvCorrectorFn): JsonObject =>
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
