import * as Effect from "effect/Effect";

import type { DbClient } from "@ktb/db";
import type { JobRegistration, JobsEnqueuer } from "@ktb/jobs-port";
import { registerJobHandler } from "@ktb/jobs-port";
import {
	ORCHESTRATOR_STEP_KIND,
	OrchestratorRegistry,
	decodeOrchestrationStepPayload,
	loadStoredDefs,
	makeOrchestrationRunner,
	orchestratorStepRegistration,
	type OrchestrationRunnerService,
	type RunOptions,
} from "@ktb/orchestrator";

/**
 * orchestration.ts — app-bound wiring for the durable orchestration
 * runner (@ktb/orchestrator phase 2). Mirrors audio-jobs.ts: the
 * runner itself is plain values, so this module only resolves the
 * host deps — the app runtime (for the OrchestratorRegistry service
 * and the ambient context kinds probe), the DbClient, and the jobs
 * enqueuer each step re-enqueues through.
 *
 * LAZY BY DESIGN: the runner (and the `orchestrator.step`
 * registration) is built on first use, inside `deps.run` — the app
 * runtime's service context IS the ambient context durable steps
 * need. `Effect.context` captures every bound service
 * (OrchestratorRegistry for `subworkflow`, EnvCorrector /
 * PlatformLlm / PlatformDecisions / LlmPort & friends for the `ai`
 * kind and the transcript pack's stages) — exactly what an
 * in-memory `registry.run` inside `run()` would see, which is the
 * contract `ambientContext` documents. Capturing under `run` (never
 * `runAs`) keeps Principal/Tenant request scope out of durable steps:
 * kinds see system scope — the run's own `tenant_id` is re-bound per
 * step inside the runner (`TenantAccess`), so a tenant-stamped run
 * still scopes correctly without inheriting request context.
 *
 * `loadStoredDefs` runs once inside the same build so defs persisted
 * through the pipeline admin fns (`orchestration_defs` rows) resolve
 * for both `start` and in-flight steps — stored defs fill gaps only;
 * code-registered defs win (see the store helper's contract).
 */

export interface OrchestrationHostDeps {
	/** `run` from lib/platform.ts — executes inside the composed app
	 * runtime with telemetry seeding. */
	readonly run: <A, E>(effect: Effect.Effect<A, E, unknown>) => Promise<A>;
	/** The app's DbClient (same client job_runs/orchestration_* share). */
	readonly db: DbClient;
	/** The jobs-port enqueuer bound to the shared queue transport —
	 * `orchestrator.step` re-enqueues itself through it. Callers only
	 * construct the host when this is bound; without a transport no
	 * step job can be produced or consumed. */
	readonly jobs: JobsEnqueuer;
}

export interface OrchestrationHost {
	/** The memoized runner — first call pays the runtime probe +
	 * stored-def load; a failed build clears the memo so the next
	 * call retries (a transient db failure must not brick the kind). */
	readonly runner: () => Promise<OrchestrationRunnerService>;
	/** `runner.start` for the ServerRuntime start surface — persists
	 * the run and enqueues its first step job. `tenantId` stamps the
	 * run row + step envelope (see OrchestrationRunnerService.start). */
	readonly startRun: (
		defId: string,
		input?: unknown,
		opts?: RunOptions,
		tenantId?: number | null,
	) => Promise<string>;
	/** Register `orchestrator.step` in the shared `jobHandlers`
	 * registry. The registration defers runner construction to first
	 * delivery (queue batches can arrive before any admin fn calls
	 * `startRun`), validates `{runId}` synchronously through the
	 * package's exported decoder, and stays `idempotent` so
	 * ack-loss redeliveries of a completed step don't re-run it. */
	readonly registerStepHandler: () => void;
}

export const makeOrchestrationHost = (deps: OrchestrationHostDeps): OrchestrationHost => {
	let runnerPromise: Promise<OrchestrationRunnerService> | undefined;
	const runner = (): Promise<OrchestrationRunnerService> => {
		runnerPromise ??= deps
			.run(
				Effect.gen(function* () {
					const registry = yield* OrchestratorRegistry;
					// Full ambient capture — see the module doc. `never` is
					// the top of the contravariant service set, so the
					// runtime's whole context satisfies
					// OrchestrationRunnerDeps.ambientContext.
					const ambientContext = yield* Effect.context<never>();
					yield* Effect.promise(() => loadStoredDefs(registry, deps.db));
					return makeOrchestrationRunner({
						db: deps.db,
						jobs: deps.jobs,
						registry,
						ambientContext,
					});
				}),
			)
			.catch((error: unknown) => {
				runnerPromise = undefined;
				throw error;
			});
		return runnerPromise;
	};

	// The inner registration owns decode+handle once the runner
	// exists; the outer wrapper only defers construction. decodePayload
	// stays synchronous (the consumer calls it before handle) via the
	// package's exported payload decoder — same validation either way.
	let registrationPromise: Promise<JobRegistration> | undefined;
	const stepRegistration = (): Promise<JobRegistration> =>
		(registrationPromise ??= runner()
			.then((r) => orchestratorStepRegistration(r))
			.catch((error: unknown) => {
				registrationPromise = undefined;
				throw error;
			}));

	return {
		runner,
		startRun: (defId, input, opts, tenantId) =>
			runner().then((r) => Effect.runPromise(r.start(defId, input, opts, tenantId))),
		registerStepHandler: () => {
			registerJobHandler(ORCHESTRATOR_STEP_KIND, {
				decodePayload: decodeOrchestrationStepPayload,
				handle: async (payload, envelope) => {
					const registration = await stepRegistration();
					await registration.handle(payload, envelope);
				},
				idempotent: true,
			});
		},
	};
};
