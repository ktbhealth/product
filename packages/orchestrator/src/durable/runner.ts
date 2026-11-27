import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { DbClient } from "@ktb/db";
import type { JobRegistration, JobsEnqueuer } from "@ktb/jobs-port";
import { TenantAccess } from "@ktb/tenant";

import type { OrchestratorRegistryService } from "../registry.ts";
import {
	createOrchestrationSession,
	restoreOrchestrationSession,
	toInitialEvent,
	type OrchestrationSnapshot,
} from "../runner.ts";
import {
	OrchestrationRunError,
	type OrchestrationDef,
	type OrchestrationKind,
	type OrchestratorError,
	type RunOptions,
} from "../types.ts";
import {
	createOrchestrationRun,
	loadOrchestrationRun,
	markOrchestrationRunFailed,
	saveOrchestrationStep,
} from "./store.ts";
import type { LoadedOrchestrationRun } from "./types.ts";

/**
 * runner.ts — the durable orchestration runner (phase 2).
 *
 * Runs survive process restarts: `start` persists the run row + seed
 * event and enqueues one `orchestrator.step` job; each step job loads
 * the run, restores an {@link OrchestrationSession} from the stored
 * snapshot + pending events, advances ONE bounded batch
 * (`batchSize`, default 50 events), persists the new boundary
 * atomically, then either marks the run terminal or enqueues the next
 * step job — so the existing jobs-port queue consumer drives
 * execution end to end.
 *
 * Consistency model — at-least-once per step BATCH: the pending queue,
 * run row and trace tail commit in one `tx` batch at each step
 * boundary. A crash mid-step leaves the previous boundary intact and
 * the retried job replays the whole batch; kinds must therefore be
 * idempotent under replay (state merges/`emit`s re-apply). Node fires
 * themselves are not individually journaled — that is the documented
 * phase-2 trade-off; per-event journaling is a later phase if needed.
 *
 * Terminal failures (event budget exceeded, unresolvable kind,
 * corrupt runtime) mark the run "failed" and ack — they are
 * permanent, not retryable. Infrastructure failures (db/jobs down)
 * defect so the consumer retries the message.
 *
 * Wiring (apps/web composition root — see the package README note):
 *
 * ```ts
 * const runner = makeOrchestrationRunner({
 *   db, jobs, registry,
 *   // ambientContext: Context.make(EnvCorrector, { correct }), // kinds'
 *   //   Effect.serviceOption port probes resolve here — the only way
 *   //   live services reach durable steps (config/events stay JSON).
 * });
 * registerJobHandler(
 *   ORCHESTRATOR_STEP_KIND,
 *   orchestratorStepRegistration(runner),
 * );
 * // at boot, after OrchestratorRegistryLive:
 * await loadStoredDefs(registry, db);
 * ```
 */

/** Job kind dispatched per step — payload `{runId}`. */
export const ORCHESTRATOR_STEP_KIND = "orchestrator.step";

/** Events processed per step job before the boundary persists. */
const DEFAULT_BATCH_SIZE = 50;

export interface OrchestrationRunnerDeps {
	readonly db: DbClient;
	/** The enqueue port — `@ktb/jobs-port`'s `Jobs` service value. */
	readonly jobs: JobsEnqueuer;
	readonly registry: OrchestratorRegistryService;
	/** Max events one step job processes (default 50). */
	readonly batchSize?: number;
	/** Ambient services provided to kind executions on every step —
	 * where kinds probe optional ports via `Effect.serviceOption`
	 * (the same idiom the in-memory runner inherits from its caller's
	 * context). Run config, events and snapshots stay JSON; live
	 * services can ONLY arrive here, so a durable run needing e.g. the
	 * transcript `EnvCorrector` port must pass it in this context
	 * (build one with `Context.make(Tag, impl)` / `Layer.build`).
	 * `Context` is contravariant in its service set, so `Context<never>`
	 * is the top type any built context satisfies. */
	readonly ambientContext?: Context.Context<never>;
	readonly newRunId?: () => string;
	readonly now?: () => number;
}

export interface OrchestrationRunnerService {
	/** Persist a new run and enqueue its first step job. Returns the
	 * run id. `tenantId` stamps `orchestration_runs.tenant_id` and the
	 * step-job envelope (NULL/absent = platform/personal scope).
	 * Fails with {@link OrchestratorError} on an unknown def id
	 * or an unresolvable node kind (validated up front, before any row
	 * is written); infrastructure failures defect. */
	readonly start: (
		defId: string,
		input?: unknown,
		opts?: RunOptions,
		tenantId?: number | null,
	) => Effect.Effect<string, OrchestratorError>;
	/** Advance one run by one bounded batch — the `orchestrator.step`
	 * job body. Missing/terminal runs are a no-op (idempotent
	 * redelivery). Permanent failures mark the run "failed"; only
	 * infrastructure failures reject (defects → queue retry). */
	readonly step: (runId: string) => Effect.Effect<void>;
}

const kindMap = (registry: OrchestratorRegistryService): ReadonlyMap<string, OrchestrationKind> =>
	new Map(registry.listKinds().map((kind) => [kind.id, kind]));

/** Human-readable failure text for the run's `error` column. Tagged
 * errors without a `message` field (UnknownOrchestrationError & co.)
 * degrade to their `_tag` so the column is never blank. */
const describe = (error: unknown): string => {
	if (error instanceof Error) {
		if (error.message !== "") return error.message;
		const tag = (error as { readonly _tag?: unknown })._tag;
		return typeof tag === "string" ? tag : error.name;
	}
	return String(error);
};

/** Best-effort promise write: rejections AND defects are swallowed —
 * for secondary bookkeeping that must never mask the primary outcome
 * (e.g. marking a run failed after an enqueue error). */
const ignorePromise = (run: () => Promise<unknown>): Effect.Effect<void> =>
	Effect.promise(run).pipe(Effect.ignoreCause);

/**
 * Build the durable runner. Deps are plain values (DbClient,
 * JobsEnqueuer, registry service) — no Layer; the composition root
 * constructs it once and hands `orchestratorStepRegistration(runner)`
 * to `registerJobHandler`.
 */
export const makeOrchestrationRunner = (
	deps: OrchestrationRunnerDeps,
): OrchestrationRunnerService => {
	const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
	const newRunId = deps.newRunId ?? (() => `orun-${crypto.randomUUID()}`);
	const now = () => deps.now?.() ?? Date.now();

	/** Enqueue the next step job. `tenantId` rides the envelope
	 * (`EnqueueJobOptions.tenantId` → `job_runs.tenant_id` + the
	 * consumer's re-bind hint) — it comes from the run row so every
	 * continuation step carries the run's own scope. `tryPromise` keeps
	 * rejections in the typed channel so callers choose the policy:
	 * `start` marks the run failed then defects; mid-run continuation
	 * defects outright (the consumer retries and the persisted boundary
	 * means the retry just continues the run). */
	const enqueueStep = (runId: string, tenantId: number | null): Effect.Effect<void, unknown> =>
		Effect.tryPromise({
			try: () => deps.jobs.enqueue(ORCHESTRATOR_STEP_KIND, { runId }, { tenantId }),
			catch: (error) => error,
		}).pipe(Effect.asVoid);

	/** One durable step: restore → bounded batch → persist → terminal
	 * or enqueue-next. Typed errors (unknown def, corrupt runtime,
	 * unresolvable kind) propagate to `step`'s catch → run marked
	 * failed. The session's own {@link OrchestrationRunError} (event
	 * budget) is handled inside — the session exists, so its trace is
	 * persisted before failing the run. */
	const advance = (
		loaded: LoadedOrchestrationRun,
		runId: string,
		ts: number,
	): Effect.Effect<void, OrchestratorError> =>
		Effect.gen(function* () {
			const def = yield* Effect.try({
				try: () => deps.registry.get(loaded.record.defId),
				catch: (error) => error as OrchestratorError,
			});
			if (loaded.runtime === null) {
				return yield* new OrchestrationRunError({
					orchestrationId: loaded.record.defId,
					message: "corrupt run state: runtime snapshot failed to parse",
					trace: [],
				});
			}
			const session = yield* restoreOrchestrationSession(
				def,
				kindMap(deps.registry),
				loaded.runtime,
				loaded.pending.map((entry) => entry.event),
			);
			const stepError = yield* session.step(batchSize).pipe(
				Effect.result,
				Effect.map((result) => (result._tag === "Failure" ? result.failure : null)),
			);
			const snapshot: OrchestrationSnapshot = session.snapshot();
			if (stepError !== null) {
				// Event budget exceeded — permanent. Persist the audit up
				// to the failure, mark the run failed, drop the queue.
				yield* Effect.promise(() =>
					saveOrchestrationStep(deps.db, {
						runId,
						queue: [],
						snapshot: { ...snapshot, error: stepError.message },
						status: "failed",
						now: ts,
					}),
				);
				return;
			}
			const finished = session.isFinished();
			yield* Effect.promise(() =>
				saveOrchestrationStep(deps.db, {
					runId,
					queue: finished ? [] : session.pendingEvents(),
					snapshot,
					status: finished ? session.result().status : "running",
					now: ts,
				}),
			);
			if (!finished) {
				yield* enqueueStep(runId, loaded.record.tenantId).pipe(
					Effect.catch((error) => Effect.die(error)),
				);
			}
		});

	return {
		start: (defId, input, opts, tenantId) =>
			Effect.gen(function* () {
				const def: OrchestrationDef = yield* Effect.try({
					try: () => deps.registry.get(defId),
					catch: (error) => error as OrchestratorError,
				});
				// Validate kind resolution up front — an unknown kind is a
				// configuration error surfaced before any row exists.
				const session = yield* createOrchestrationSession(def, kindMap(deps.registry), {
					input,
					config: opts?.config,
					onNodeError: opts?.onNodeError,
					maxEvents: opts?.maxEvents,
				});
				const runId = newRunId();
				const ts = now();
				yield* Effect.promise(() =>
					createOrchestrationRun(deps.db, {
						id: runId,
						defId: def.id,
						defVersion: def.version ?? "1",
						snapshot: session.snapshot(),
						initialEvent: toInitialEvent(input),
						tenantId: tenantId ?? null,
						now: ts,
					}),
				);
				// Enqueue failure leaves a "running" row with no driver —
				// mark it failed (best-effort) before defecting.
				yield* enqueueStep(runId, tenantId ?? null).pipe(
					Effect.catch((error) =>
						Effect.gen(function* () {
							yield* ignorePromise(() =>
								markOrchestrationRunFailed(
									deps.db,
									runId,
									`step enqueue failed: ${describe(error)}`,
									ts,
								),
							);
							return yield* Effect.die(error);
						}),
					),
				);
				return runId;
			}),

		step: (runId) =>
			Effect.gen(function* () {
				const loaded = yield* Effect.promise(() => loadOrchestrationRun(deps.db, runId));
				if (loaded === null || loaded.record.status !== "running") {
					// Unknown or terminal run — idempotent no-op so queue
					// redeliveries ack cleanly.
					return;
				}
				const stepFx = advance(loaded, runId, now()).pipe(
					Effect.catch((error) =>
						Effect.promise(() =>
							markOrchestrationRunFailed(deps.db, runId, describe(error), now()),
						).pipe(Effect.asVoid),
					),
				);
				// Kind effects run with an empty context by default —
				// provideContext is what lets `Effect.serviceOption`
				// probes (EnvCorrector & friends) resolve ambient ports
				// during durable steps. TenantAccess is merged INTO that
				// context (an outer provideService would be shadowed by
				// provideContext): the run's tenant_id re-binds tenant
				// scope for kinds — the durable counterpart of
				// `runAsTenantId` on queue consumers. NULL tenant runs
				// keep ambient (personal/system) scope; without an
				// ambientContext the binding is a plain provideService
				// over the caller's context.
				const ambient = deps.ambientContext;
				const scoped =
					ambient === undefined
						? loaded.record.tenantId === null
							? stepFx
							: Effect.provideService(stepFx, TenantAccess, [loaded.record.tenantId])
						: Effect.provideContext(
								stepFx,
								loaded.record.tenantId === null
									? ambient
									: Context.add(ambient, TenantAccess, [loaded.record.tenantId]),
							);
				yield* scoped;
			}),
	};
};

const StepPayload = Schema.Struct({ runId: Schema.String });

/** Decode an `orchestrator.step` payload (`{runId}`) — the wire
 * contract, exported so composition-side wrappers that defer runner
 * construction (lazy `jobHandlers` registrations, server-fn starters)
 * validate identically without owning a runner instance. Throws a
 * `ParseError` on any other shape — the consumer's poison path. */
export const decodeOrchestrationStepPayload = (payload: unknown): { readonly runId: string } =>
	Schema.decodeUnknownSync(StepPayload)(payload);

/**
 * `JobRegistration` for `orchestrator.step` — wire once at app
 * composition:
 *
 * ```ts
 * registerJobHandler(ORCHESTRATOR_STEP_KIND, orchestratorStepRegistration(runner));
 * ```
 *
 * `decodePayload` rejects non-`{runId}` bodies (poison → ack, never
 * retried); `handle` runs one bounded step. `idempotent: true` lets
 * the consumer ack-loss-redeliveries of an already-done step job
 * without re-running — and even a re-run is safe (terminal/missing
 * runs no-op, mid-run steps just advance the batch boundary).
 */
export const orchestratorStepRegistration = (
	runner: OrchestrationRunnerService,
): JobRegistration => ({
	decodePayload: decodeOrchestrationStepPayload,
	handle: (payload) =>
		Effect.runPromise(runner.step((payload as { readonly runId: string }).runId)),
	idempotent: true,
});
