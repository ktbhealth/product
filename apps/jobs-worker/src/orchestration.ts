/**
 * orchestration.ts — `orchestrator.step` wiring for the local jobs
 * worker. Mirrors apps/web/src/lib/orchestration.ts's lazy host, minus
 * the app runtime: this process composes no plugins, so the registry
 * is `builtinKinds` + the eval-port `ai` kind (@ktb/orchestrator-ai,
 * imported directly — it is a package, not a plugin contribution) +
 * `loadStoredDefs` only.
 *
 * KNOWN GAPS (honest dev-mode limits):
 * - Plugin-contributed `orchestrations` packs are NOT loaded — the
 *   worker never builds the plugin graph, so defs/kinds contributed by
 *   manifests (e.g. pipeline.transcript's consultation-transcript def
 *   and its stage kinds) are absent. Stored defs or admin-started runs
 *   that reference pack kinds fail kind resolution and mark the run
 *   "failed"; defs using builtin kinds (emit/gate/poll/subworkflow)
 *   or the `ai` kind run end to end.
 * - ambientContext carries ONLY the OrchestratorRegistry (so the
 *   `subworkflow` kind's serviceOption probe resolves for nested
 *   in-memory runs). EnvCorrector lives in @ktb/plugin-pipeline-transcript
 *   and the eval AI ports (LlmPort/DecisionsPort/AsrPort and the
 *   PlatformLlm/PlatformDecisions factories the `ai` kind probes via
 *   @ktb/orchestrator-ai) need provider bindings this process does not
 *   compose — the `ai` kind therefore degrades to
 *   `{skipped: true, reason: "no-port"}` by design (the configured
 *   event is still emitted, graphs keep routing).
 *
 * Requires the worker db (orchestration_* tables live beside
 * job_runs): callers register only when `openWorkerDb()` returned a
 * client — JOBS_DB=off means no durable runs locally.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { DbClient } from "@ktb/db";
import type { JobHandlerRegistry, JobRegistration, JobsEnqueuer } from "@ktb/jobs-port";
import {
	ORCHESTRATOR_STEP_KIND,
	OrchestratorRegistry,
	builtinKinds,
	decodeOrchestrationStepPayload,
	loadStoredDefs,
	makeOrchestrationRunner,
	makeOrchestratorRegistry,
	orchestratorStepRegistration,
	type OrchestrationRunnerService,
	type RunOptions,
} from "@ktb/orchestrator";
import { aiOrchestrationKind } from "@ktb/orchestrator-ai";

export interface OrchestrationWorkerDeps {
	/** The worker's DbClient — orchestration_runs/events/node_runs and
	 * orchestration_defs all live in the same db job_runs projects to. */
	readonly db: DbClient;
	/** Jobs enqueuer bound to the SAME Redis transport the worker
	 * consumes — `orchestrator.step` re-enqueues itself through it. */
	readonly jobs: JobsEnqueuer;
}

export interface OrchestrationWorker {
	/** The memoized runner — first call pays the stored-def load; a
	 * failed build clears the memo so the next call retries. */
	readonly runner: () => Promise<OrchestrationRunnerService>;
	/** `runner.start` — persists a run and enqueues its first step job.
	 * The worker exposes no admin surface today; this exists for tests
	 * and manual `bun -e` driving. */
	readonly startRun: (defId: string, input?: unknown, opts?: RunOptions) => Promise<string>;
	/** Register `orchestrator.step` in the worker's composition-built
	 * job-handler registry — `{runId}` decoded synchronously, runner
	 * construction deferred to first delivery. */
	readonly registerStepHandler: (registry: JobHandlerRegistry) => void;
}

export const makeOrchestrationWorker = (deps: OrchestrationWorkerDeps): OrchestrationWorker => {
	let runnerPromise: Promise<OrchestrationRunnerService> | undefined;
	const runner = (): Promise<OrchestrationRunnerService> => {
		runnerPromise ??= (async () => {
			// builtinKinds + the eval-port `ai` kind: the kind is a plain
			// value in @ktb/orchestrator-ai (not a plugin pack), so the
			// plugin-free worker can register it directly and keep the
			// pre-refactor degrade contract — stored defs with `ai` nodes
			// still run and degrade to no-port instead of failing kind
			// resolution.
			const registry = makeOrchestratorRegistry([...builtinKinds, aiOrchestrationKind]);
			await loadStoredDefs(registry, deps.db);
			return makeOrchestrationRunner({
				db: deps.db,
				jobs: deps.jobs,
				registry,
				// Only the registry is ambient — see the module doc for
				// what is deliberately absent (EnvCorrector, the eval
				// LlmPort/DecisionsPort/AsrPort/Platform* services).
				ambientContext: Context.make(OrchestratorRegistry, registry),
			});
		})().catch((error: unknown) => {
			runnerPromise = undefined;
			throw error;
		});
		return runnerPromise;
	};

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
		startRun: (defId, input, opts) =>
			runner().then((r) => Effect.runPromise(r.start(defId, input, opts))),
		registerStepHandler: (registry) => {
			registry.register(ORCHESTRATOR_STEP_KIND, {
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
