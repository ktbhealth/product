import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
	DuplicatePipelineError,
	PipelineRunError,
	PipelineStageError,
	UnknownPipelineError,
	UnknownStageError,
	type PipelineDef,
	type PipelinePack,
	type PipelineResult,
	type PipelineStage,
	type StageContext,
	type StageResult,
	type StageTrace,
} from "./types.ts";

/**
 * registry.ts — the pipeline registry and runner.
 *
 * `PipelineRegistry` is an Effect service tag (same `Context.Service`
 * idiom as the eval ports) holding an in-memory id → pack map, in the
 * spirit of `ContributionRegistry` (packages/eval-core) but as a
 * service so consumers resolve it ambiently. `register` is synchronous
 * and throws typed errors — pack validation is a programming error,
 * surfaced at composition time, not a run-time failure.
 *
 * `run` sequences `def.stages` in order: each stage's `run` gets a
 * {@link StageContext} built from the live accumulated state, its
 * `StageResult.state` merges into that state and its output is aliased
 * at `state[stageId]`. Failures follow the entry's `onError` policy —
 * see {@link StageTrace} for the trace/status contract.
 */

/** The registry surface. `register`/`get`/`has`/`list` are synchronous
 * (typed throws, ContributionRegistry-style); `run` is the only Effect
 * — stage effects may declare arbitrary requirements, which the
 * registry does not provide (ambient probing via `Effect.serviceOption`
 * is the supported idiom). */
export interface PipelineRegistryService {
	/** Register a pack. Throws {@link DuplicatePipelineError} when
	 * `def.id` is already registered and {@link UnknownStageError} when
	 * a `def.stages` entry has no matching key in `pack.stages`. */
	readonly register: (pack: PipelinePack) => void;
	/** The registered pack for `id`. Throws {@link UnknownPipelineError}
	 * when absent. */
	readonly get: (id: string) => PipelinePack;
	readonly has: (id: string) => boolean;
	/** All registered defs in registration order. */
	readonly list: () => readonly PipelineDef[];
	/** Run the pipeline `id` over `input`. `config` overrides the pack's
	 * pipeline-level config for this invocation (absent → pack config →
	 * `{}`). Fails with {@link PipelineRunError} on an unknown id or a
	 * stage failure under `onError: "halt"`. */
	readonly run: (
		id: string,
		input: unknown,
		config?: Readonly<Record<string, unknown>>,
	) => Effect.Effect<PipelineResult, PipelineRunError>;
}

export class PipelineRegistry extends Context.Service<PipelineRegistry, PipelineRegistryService>()(
	"@ktb/pipeline/PipelineRegistry",
) {}

/** Normalize whatever a stage effect failed with into
 * {@link PipelineStageError}: a stage that already speaks the contract
 * passes through untouched; foreign error values are wrapped with their
 * stringified form as `message` and the original as `cause`. */
const toStageError = (stageId: string, error: unknown): PipelineStageError =>
	error instanceof PipelineStageError
		? error
		: new PipelineStageError({
				stageId,
				message: error instanceof Error ? error.message : String(error),
				cause: error,
			});

/** Invoke `stage.run` defensively: a synchronous throw becomes a typed
 * {@link PipelineStageError} instead of a defect, and the effect's
 * failure channel is normalized through {@link toStageError}. The `as`
 * cast erases the stage's `unknown` requirement channel — the registry
 * cannot provide stage requirements by construction; stages that need
 * ambient services must probe them optionally (`Effect.serviceOption`). */
const invokeStage = (
	stage: PipelineStage,
	ctx: StageContext,
): Effect.Effect<StageResult, PipelineStageError> =>
	Effect.suspend(() => {
		try {
			return stage.run(ctx) as Effect.Effect<StageResult, PipelineStageError>;
		} catch (cause) {
			return Effect.fail(
				new PipelineStageError({
					stageId: stage.id,
					message: cause instanceof Error ? cause.message : String(cause),
					cause,
				}),
			);
		}
	}).pipe(Effect.catch((error) => Effect.fail(toStageError(stage.id, error))));

const runPipeline = (
	pack: PipelinePack,
	input: unknown,
	config: Readonly<Record<string, unknown>>,
): Effect.Effect<PipelineResult, PipelineRunError> =>
	Effect.gen(function* () {
		const state: Record<string, unknown> = {};
		const trace: StageTrace[] = [];

		for (const entry of pack.def.stages) {
			// Guaranteed present: register() rejects defs whose entries
			// have no matching stage implementation.
			const stage = pack.stages[entry.id] as PipelineStage;
			const started = Date.now();
			const ctx: StageContext = {
				input,
				state: { ...state },
				config,
				stageConfig: entry.config ?? {},
			};

			const outcome = yield* invokeStage(stage, ctx).pipe(
				Effect.map((result): { ok: true; result: StageResult } => ({ ok: true, result })),
				Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
			);
			const latencyMs = Date.now() - started;

			if (!outcome.ok) {
				const failed: StageTrace = {
					stageId: entry.id,
					status: entry.onError === "skip" ? "skipped" : "failed",
					latencyMs,
					error: outcome.error.message,
				};
				trace.push(failed);
				if (entry.onError !== "skip") {
					return yield* new PipelineRunError({
						pipelineId: pack.def.id,
						stageId: entry.id,
						message: outcome.error.message,
						cause: outcome.error.cause,
						trace: [...trace],
					});
				}
				// onError "skip": keep going — the stage contributed
				// nothing to state.
				continue;
			}

			const { result } = outcome;
			if (result.state !== undefined) {
				Object.assign(state, result.state);
			}
			state[entry.id] = result.output ?? result.state ?? {};
			trace.push({ stageId: entry.id, status: "ok", latencyMs });
		}

		return { state, trace } satisfies PipelineResult;
	});

/** Build a standalone registry service value (no Effect context
 * needed) — tests and non-Effect callers use this directly;
 * {@link PipelineRegistryLive} wraps it as a Layer. */
export const makePipelineRegistry = (): PipelineRegistryService => {
	const packs = new Map<string, PipelinePack>();

	return {
		register(pack) {
			if (packs.has(pack.def.id)) {
				throw new DuplicatePipelineError({ pipelineId: pack.def.id });
			}
			for (const entry of pack.def.stages) {
				if (pack.stages[entry.id] === undefined) {
					throw new UnknownStageError({
						pipelineId: pack.def.id,
						stageId: entry.id,
					});
				}
			}
			packs.set(pack.def.id, pack);
		},

		get(id) {
			const pack = packs.get(id);
			if (pack === undefined) {
				throw new UnknownPipelineError({ pipelineId: id });
			}
			return pack;
		},

		has(id) {
			return packs.has(id);
		},

		list() {
			return [...packs.values()].map((pack) => pack.def);
		},

		run(id, input, config) {
			const pack = packs.get(id);
			if (pack === undefined) {
				return Effect.fail(
					new PipelineRunError({
						pipelineId: id,
						message: `unknown pipeline: ${id}`,
						trace: [],
					}),
				);
			}
			return runPipeline(pack, input, config ?? pack.config ?? {});
		},
	};
};

/** Layer that registers every pack at build time — the composition-root
 * entry point (a plugin's services layer or the host runtime provides
 * `PipelineRegistryLive(packs)` once, collected from plugin manifests'
 * `pipelines` field). Registration failures surface as the layer's
 * error channel, preserving the typed {@link DuplicatePipelineError}/
 * {@link UnknownStageError} instead of defecting. */
export const PipelineRegistryLive = (
	packs: readonly PipelinePack[],
): Layer.Layer<PipelineRegistry, DuplicatePipelineError | UnknownStageError> =>
	Layer.effect(
		PipelineRegistry,
		Effect.gen(function* () {
			const registry = makePipelineRegistry();
			for (const pack of packs) {
				// register() only throws the two typed validation errors —
				// the cast narrows Effect.try's `unknown` catch channel to
				// exactly them, so layer-build failures stay typed.
				yield* Effect.try({
					try: () => registry.register(pack),
					catch: (cause) => cause as DuplicatePipelineError | UnknownStageError,
				});
			}
			return registry;
		}),
	);
