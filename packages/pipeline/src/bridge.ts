import * as Effect from "effect/Effect";
import type { JsonObject } from "effect/Schema";
import type {
	KindResult,
	NodeContext,
	OrchestrationKind,
	OrchestrationNode,
	OrchestrationPack,
} from "@ktb/orchestrator";

import {
	PipelineStageError,
	type PipelinePack,
	type PipelineStage,
	type StageContext,
	type StageResult,
	UnknownStageError,
} from "./types.ts";

/**
 * bridge.ts — the canonical @ktb/pipeline → @ktb/orchestrator
 * translation. Two engines, one semantics: a {@link PipelineStage} is
 * domain-blind ordered work; an {@link OrchestrationKind} is the same
 * work fired by an event. This module is the ONLY place that mapping
 * lives — plugins contribute packs, never hand-rolled adapters.
 *
 * DEPENDENCY NOTE: every @ktb/orchestrator reference here is
 * `import type` — the bridge is checked against the orchestrator's
 * PUBLIC kind contract (`OrchestrationKind`/`NodeContext`/`KindResult`/
 * `OrchestrationPack`, all in types.ts) without a runtime or package
 * dependency. That keeps @ktb/pipeline free of the orchestrator's
 * db/jobs/tenant graph AND immune to builtin-kind churn (the kinds
 * themselves are never named — only the registration surface is).
 * A structural drift in the public contract surfaces as a type error
 * at the consumer that assigns the result to `OrchestrationKind`.
 *
 * WHAT TRANSLATES (linear defs):
 * - `def.stages` order → a chain of nodes where node i subscribes to
 *   the previous node's `${def.id}.${stageId}.done` event; the first
 *   node subscribes to `"input"` (object run input) and `"start"`
 *   (bare `run(id)` — the pipeline's `input: undefined` case).
 * - `entry.id` → `node.id`, so `KindResult.output` lands at
 *   `state[node.id]` exactly like the pipeline's `state[stageId]`
 *   aliasing — INCLUDING the `output ?? state ?? {}` fallback.
 * - `entry.config` → `node.params` → `StageContext.stageConfig`.
 * - `pack.config`/`def.{id,version,description}` → `OrchestrationDef`
 *   fields. NOTE the config merge differs: the pipeline REPLACES its
 *   config with the run override (`config ?? pack.config`); the
 *   orchestrator MERGES `def.config` under `RunOptions.config`.
 * - `entry.onError`: "skip" is enforced INSIDE the kind (typed stage
 *   failures are caught, logged, contribute no state, and the
 *   follow-up event still emits — the only way the chain continues,
 *   since a failed orchestrator node emits nothing). "halt" lets the
 *   failure propagate as a node failure; the derived def's
 *   `onNodeError: "halt"` then ends the run — the pipeline's halt
 *   semantics. Defects are never caught on either engine.
 *
 * WHAT DOES NOT TRANSLATE (documented edges — the derivation is
 * offered for defs where these do not apply):
 * - Branching/fan-out/fan-in: a PipelineDef is strictly sequential;
 *   there is no construct to translate. Orchestrator-only features
 *   (fanIn, retry, circuitBreaker, maxFires, until/retireOn, inline
 *   `handler`) have no pipeline analog and are simply absent.
 * - Non-object or `null` run inputs: `toInitialEvent` wraps them as
 *   `{value}` payloads, and `undefined` input becomes the `start`
 *   event — recovered as `undefined` here, but primitives arrive as
 *   `{value: …}`. Object inputs pass through verbatim.
 * - Inputs with a top-level `input` key, or derived-def event types
 *   literally named `input`/`start`: the wire-input convention
 *   (`payload.input ?? payload` on entry events, `payload.input` on
 *   chained events) cannot distinguish them — keep pipeline inputs
 *   free of a top-level `input` field.
 * - Duplicate stage ids within one def: the pipeline would run both
 *   entries sequentially (second overwrites `state[id]`); the
 *   orchestration fires both nodes on the same trigger event. Don't
 *   derive defs with duplicate stage ids.
 * - Failure surface: pipeline halt → `PipelineRunError`; orchestration
 *   halt → run `status: "failed"` + `node.failed`/`workflow.failed`
 *   lifecycle events (not a thrown error). Skip traces record "ok" on
 *   the orchestration where the pipeline says "skipped" — the disabled
 *   state fragments are the honest observable either way.
 * - `OrchestrationDef`s produced here are code-side objects (kinds are
 *   real registered handlers, not inline `handler`s) — persisting them
 *   through `orchestration_defs` requires the data-only path and is
 *   out of scope.
 */

/** Everything an emit-payload builder sees for one stage fire. `result`
 * is `null` exactly when the stage failed under `onError: "skip"`. */
export interface StageKindFire {
	readonly input: unknown;
	readonly result: StageResult | null;
	readonly ctx: NodeContext;
}

/** Options for {@link pipelineStageKind}. `id` defaults to the stage
 * id (namespace it when registering several adapted stages — the
 * derivation uses `pipeline.<defId>.<stageId>`). `onError` mirrors the
 * PipelineStageEntry policy (default "halt", the pipeline default).
 * `emit` declares the follow-up event the node produces after EVERY
 * fire — success AND skip — which is how a derived chain continues;
 * omit it for terminal/manual wiring. `payload` defaults to forwarding
 * the stage's state fragment plus the wire input under `input`. */
export interface PipelineStageKindOptions {
	readonly id?: string;
	readonly onError?: "halt" | "skip";
	readonly emit?: {
		readonly type: string;
		readonly payload?: (fire: StageKindFire) => JsonObject;
	};
}

/** Recover the pipeline input from the triggering event. Entry events
 * (`"input"` synthesized by `toInitialEvent` for object inputs, `"start"`
 * for bare runs) recover the raw input — `"start"` maps to `undefined`,
 * matching `registry.run(id)` with no input argument. Every other event
 * type is a chained emit and MUST carry the original input under
 * `payload.input` (the derived defs guarantee this); a missing key
 * recovers `undefined`, not the payload. See the module doc for the
 * reserved-type/`input`-key caveats. */
const inputOf = (event: NodeContext["event"]): unknown => {
	if (event.type === "start") {
		return undefined;
	}
	const payload = event.payload as Record<string, unknown>;
	if (event.type === "input") {
		return payload["input"] ?? payload;
	}
	return payload["input"];
};

/** Default emit payload: the stage's state fragment spread at top
 * level (the transcript-pack convention — `gate`/`cleanup` keys stay
 * visible on the event) with the wire input forwarded under `input`,
 * written LAST so a fragment's own `input` key can never clobber the
 * pipeline input the next stage needs. `input` is omitted when
 * `undefined` (not JSON-representable as a meaningful value). */
const defaultEmitPayload = ({ input, result }: StageKindFire): JsonObject => {
	const payload: Record<string, unknown> = { ...(result?.state ?? {}) };
	if (input !== undefined) {
		payload["input"] = input;
	}
	return payload as JsonObject;
};

/** Adapt a {@link PipelineStage} into an {@link OrchestrationKind} —
 * the single canonical stage→kind translation. The kind rebuilds the
 * {@link StageContext} from the node context (event payload → `input`,
 * run state → `state`, merged config → `config`, `node.params` →
 * `stageConfig`), invokes the stage with the pipeline runner's
 * defensive semantics (sync throws become typed {@link
 * PipelineStageError}s; defects escape untouched), applies the
 * `onError` policy, and maps the {@link StageResult} back with the
 * pipeline's state aliasing (`output ?? state ?? {}` stored at
 * `state[node.id]` by the runner — node ids equal stage ids in derived
 * defs). */
export const pipelineStageKind = (
	stage: PipelineStage,
	options: PipelineStageKindOptions = {},
): OrchestrationKind => {
	const onError = options.onError ?? "halt";
	const emitType = options.emit?.type;
	const emitPayload = options.emit?.payload ?? defaultEmitPayload;

	return {
		id: options.id ?? stage.id,
		run: (ctx) =>
			Effect.gen(function* () {
				const input = inputOf(ctx.event);
				const stageCtx: StageContext = {
					input,
					state: ctx.state,
					config: ctx.config as Readonly<Record<string, unknown>>,
					stageConfig: ctx.params as Readonly<Record<string, unknown>>,
				};

				// Same defensive invocation as the pipeline runner's
				// invokeStage: a synchronous throw becomes a typed
				// PipelineStageError; the `as` cast erases the stage's
				// `unknown` requirement channel (ambient probing via
				// Effect.serviceOption is the supported idiom).
				const invoke = Effect.suspend(() => {
					try {
						return stage.run(stageCtx) as Effect.Effect<StageResult, PipelineStageError>;
					} catch (cause) {
						return Effect.fail(
							new PipelineStageError({
								stageId: stage.id,
								message: cause instanceof Error ? cause.message : String(cause),
								cause,
							}),
						);
					}
				});

				// onError "skip": typed failures (PipelineStageError or any
				// foreign value in the channel) log and yield null — no
				// state contribution, follow-up event still emitted, the
				// chain continues exactly like the sequential pack.
				// Defects are NOT caught (Effect.catch covers the error
				// channel only), matching the pipeline runner. "halt"
				// propagates: the runner normalizes it into a node
				// failure and the def/run onNodeError policy applies.
				const result = yield* onError === "skip"
					? invoke.pipe(
							Effect.catch((error) =>
								Effect.logWarning("pipeline stage failed; continuing (onError: skip)", {
									stage: stage.id,
									error: error instanceof PipelineStageError ? error.message : String(error),
								}).pipe(Effect.as(null)),
							),
						)
					: invoke;

				const kindResult: KindResult =
					result === null
						? {}
						: {
								...(result.state !== undefined ? { state: result.state as JsonObject } : {}),
								// Pipeline aliasing: state[stageId] =
								// output ?? state ?? {} — the runner writes
								// KindResult.output at state[node.id], and
								// node.id === stage.id in derived defs.
								output: result.output ?? result.state ?? {},
							};

				if (emitType === undefined) {
					return kindResult;
				}
				return {
					...kindResult,
					events: [
						{
							type: emitType,
							payload: emitPayload({ input, result, ctx }),
						},
					],
				};
			}),
	};
};

/** Options for {@link pipelinePackToOrchestration}. */
export interface PipelineOrchestrationOptions {
	/** Def-level node failure policy — "halt" (default) mirrors the
	 * pipeline's halt-on-stage-failure; "continue" is only meaningful
	 * for defs whose entries are all `onError: "skip"` (those failures
	 * never reach node level anyway). */
	readonly onNodeError?: "halt" | "continue";
}

/** The event type a derived node emits and its successor subscribes
 * to. Namespaced by def id so two derived defs in one registry can
 * never cross-talk (events are per-run regardless, but the names stay
 * self-describing in the run's event log). */
const stageEventType = (defId: string, stageId: string): string => `${defId}.${stageId}.done`;

/** The kind id a derived node resolves — namespaced by def id so the
 * same stage id in two packs never collides in the kind registry. */
const stageKindId = (defId: string, stageId: string): string => `pipeline.${defId}.${stageId}`;

/** Derive an {@link OrchestrationPack} (def + kinds) from a linear
 * {@link PipelinePack} — the PipelineDef → OrchestrationDef
 * translation. Every `def.stages` entry becomes one node wired to the
 * next by the `*.done` event convention; every entry's stage
 * implementation becomes a registered kind via {@link
 * pipelineStageKind} with the entry's `onError`/`config` applied.
 * Returns a pack (not a bare def) so the result drops straight into a
 * plugin manifest's `orchestrations` field or
 * `OrchestratorRegistryLive(kinds, defs)`. Throws {@link
 * UnknownStageError} when the pack is invalid (a def entry with no
 * `pack.stages` implementation) — the same contract
 * `PipelineRegistry.register` enforces, surfaced eagerly here. */
export const pipelinePackToOrchestration = (
	pack: PipelinePack,
	options: PipelineOrchestrationOptions = {},
): OrchestrationPack => {
	const def = pack.def;
	const kinds = def.stages.map((entry) => {
		const stage = pack.stages[entry.id];
		if (stage === undefined) {
			throw new UnknownStageError({ pipelineId: def.id, stageId: entry.id });
		}
		return pipelineStageKind(stage, {
			id: stageKindId(def.id, entry.id),
			onError: entry.onError ?? "halt",
			emit: { type: stageEventType(def.id, entry.id) },
		});
	});
	const nodes: OrchestrationNode[] = [];
	for (const [index, entry] of def.stages.entries()) {
		nodes.push({
			id: entry.id,
			kind: stageKindId(def.id, entry.id),
			on: index === 0 ? ["input", "start"] : [stageEventType(def.id, def.stages[index - 1].id)],
			emits: [stageEventType(def.id, entry.id)],
			...(entry.config !== undefined ? { params: entry.config as JsonObject } : {}),
		});
	}
	return {
		def: {
			id: def.id,
			...(def.version !== undefined ? { version: def.version } : {}),
			...(def.description !== undefined ? { description: def.description } : {}),
			...(pack.config !== undefined ? { config: pack.config as JsonObject } : {}),
			onNodeError: options.onNodeError ?? "halt",
			nodes,
		},
		kinds,
	};
};
