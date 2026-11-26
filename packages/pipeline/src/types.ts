import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/**
 * types.ts — the pipeline contract. A pipeline is a domain-blind,
 * ordered sequence of named stages: a {@link PipelineDef} declares the
 * steps (data), a {@link PipelinePack} pairs it with the stage
 * implementations (code), and the {@link PipelineRegistry} sequences
 * them at run time.
 *
 * Stage implementations are plain Effect functions that probe ambient
 * ports via `Effect.serviceOption` — the same idiom as `makeEvalRunner`
 * (packages/eval-adapter-local): a stage that finds its port absent
 * degrades gracefully instead of requiring the service in its
 * requirements. The `unknown` requirement channel on {@link
 * PipelineStage.run} is deliberately permissive — the registry does not
 * provide stage requirements, so stages should keep theirs empty
 * (serviceOption yields `Option`, not a requirement).
 *
 * No platform APIs, no node:*, no provider literals — the package runs
 * unchanged in workerd.
 */

/** Everything a stage sees on each invocation. `input` is the pipeline
 * input (never mutated by the runner); `state` is a snapshot of the
 * accumulated outputs of the stages that already ran; `config` is the
 * pipeline-level config (pack `config` or the `run` override); and
 * `stageConfig` is this stage's entry from `def.stages`. */
export interface StageContext {
	readonly input: unknown;
	readonly state: Readonly<Record<string, unknown>>;
	readonly config: Readonly<Record<string, unknown>>;
	readonly stageConfig: Readonly<Record<string, unknown>>;
}

/** What a stage returns: `state` merges into the pipeline state,
 * `output` is the stage's primary result and is ALSO stored at
 * `state[stageId]` (output wins when both are present; with neither,
 * `{}` is stored). */
export interface StageResult {
	readonly state?: Readonly<Record<string, unknown>>;
	readonly output?: unknown;
}

/** A stage failed — `stageId` identifies the def entry, `message` is
 * human-readable, `cause` chains the underlying failure when there is
 * one. The registry normalizes ANY typed failure a stage effect
 * produces into this shape (a stage that fails with a foreign error
 * type is wrapped, not propagated raw). */
export class PipelineStageError extends Data.TaggedError("PipelineStageError")<{
	readonly stageId: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** A named, versioned unit of pipeline work. `run` receives the
 * {@link StageContext} and returns a {@link StageResult}; its error
 * channel is {@link PipelineStageError} and its requirement channel is
 * intentionally `unknown` (see the module doc — prefer ambient probing
 * via `Effect.serviceOption`). */
export interface PipelineStage {
	readonly id: string;
	readonly version?: string;
	readonly description?: string;
	readonly run: (ctx: StageContext) => Effect.Effect<StageResult, PipelineStageError, unknown>;
}

/** One ordered step in a {@link PipelineDef}. `onError` selects the
 * failure policy: "halt" (default) fails the whole run;
 * "skip" records the stage as skipped in the trace and continues with
 * the next stage. `config` lands on `StageContext.stageConfig`. */
export interface PipelineStageEntry {
	readonly id: string;
	readonly onError?: "halt" | "skip";
	readonly config?: Readonly<Record<string, unknown>>;
}

/** The declarative half of a pipeline: identity plus the ordered stage
 * entries. Entries reference stage implementations by `id` — every id
 * must exist in the pack's `stages` map (enforced at registration). */
export interface PipelineDef {
	readonly id: string;
	readonly version?: string;
	readonly description?: string;
	readonly stages: readonly PipelineStageEntry[];
}

/** A pack = def (data) + stage implementations, contributed by a
 * plugin. `config` is the pipeline-level config handed to every stage
 * as `StageContext.config` — a `run` call may override it per
 * invocation. */
export interface PipelinePack {
	readonly def: PipelineDef;
	readonly stages: Readonly<Record<string, PipelineStage>>;
	readonly config?: Readonly<Record<string, unknown>>;
}

/** Per-stage audit entry appended on every reached stage. Statuses:
 * "ok" — the stage succeeded; "skipped" — the stage ran but failed
 * under `onError: "skip"` (its output is absent from the final state);
 * "failed" — the stage failed under "halt" and ended the run, so it
 * only ever appears on the trace carried by {@link PipelineRunError}.
 * Stages after a halt are never traced. */
export interface StageTrace {
	readonly stageId: string;
	readonly status: "ok" | "skipped" | "failed";
	readonly latencyMs: number;
	readonly error?: string;
}

/** The outcome of a successful run: the accumulated state (each stage
 * id aliased to its output) plus the per-stage trace in execution
 * order. */
export interface PipelineResult {
	readonly state: Readonly<Record<string, unknown>>;
	readonly trace: readonly StageTrace[];
}

/** `run` was called for a pipeline id that was never registered. */
export class UnknownPipelineError extends Data.TaggedError("UnknownPipelineError")<{
	readonly pipelineId: string;
}> {}

/** A pack's `def.id` was already registered — pipeline ids are unique
 * across the registry, like contribution ids in eval-core. */
export class DuplicatePipelineError extends Data.TaggedError("DuplicatePipelineError")<{
	readonly pipelineId: string;
}> {}

/** A `def.stages` entry references a stage id missing from
 * `pack.stages` — every ordered step must resolve to an implementation
 * at registration time, never mid-run. */
export class UnknownStageError extends Data.TaggedError("UnknownStageError")<{
	readonly pipelineId: string;
	readonly stageId: string;
}> {}

/** The run failed. `stageId` names the failing def entry (absent when
 * the failure is not stage-scoped, e.g. an unknown pipeline id);
 * `trace` carries the per-stage audit up to and including the failure
 * (empty for unknown-pipeline failures). */
export class PipelineRunError extends Data.TaggedError("PipelineRunError")<{
	readonly pipelineId: string;
	readonly stageId?: string;
	readonly message: string;
	readonly cause?: unknown;
	readonly trace: readonly StageTrace[];
}> {}
