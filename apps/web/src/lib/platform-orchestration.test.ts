import { describe, expect, it, vi } from "vitest";

import type { JobEnvelope } from "@ktb/jobs-port";

// platform.ts wires the durable orchestration runner (P-120 phase 2):
// `orchestrator.step` registers in jobHandlers and the ServerRuntime
// gains the `orchestration.startRun` capability — both only when
// AUDIO_QUEUE is bound. Same recompose pattern as platform-jobs.test.ts.
//
// NOTE on module identity: vi.resetModules() gives every re-imported
// module a FRESH instance — @ktb/jobs-port's jobHandlers registry and
// @ktb/orchestrator's helpers must be imported AFTER compose so the
// test touches the same registry platform.ts populated.

const compose = async (configure: (env: Record<string, unknown>) => void) => {
	vi.resetModules();
	const { env } = await import("#/test/cloudflare-workers.ts");
	configure(env as Record<string, unknown>);
	const platform = await import("./platform.ts");
	const { getServerRuntime } = await import("@ktb/server-fns");
	const { jobHandlers } = await import("@ktb/jobs-port");
	const orchestrator = await import("@ktb/orchestrator");
	return { runtime: getServerRuntime(), platform, jobHandlers, orchestrator };
};

describe("platform orchestrator.step wiring", () => {
	it(
		"registers the kind, exposes startRun, and drives a durable run end to end",
		{ timeout: 60_000 }, // first compose pays the full app import cost
		async () => {
			const { runtime, platform, jobHandlers, orchestrator } = await compose(() => {});

			// Kind registered + listed for the consoles.
			const registration = jobHandlers[orchestrator.ORCHESTRATOR_STEP_KIND];
			expect(registration).toBeDefined();
			expect(registration?.idempotent).toBe(true);
			expect(runtime.jobKinds?.()).toContain(orchestrator.ORCHESTRATOR_STEP_KIND);
			expect(runtime.orchestration?.startRun).toBeDefined();

			// Persist a data-only def (builtin "emit" kind — no handler
			// functions cross the durable boundary), then start a run
			// through the ServerRuntime capability: the runner builds
			// lazily, loads stored defs, persists the run and enqueues
			// the first step job onto the fake queue transport.
			await orchestrator.upsertOrchestrationDef(platform.db, {
				id: "e2e-smoke",
				nodes: [
					{
						id: "a",
						kind: "emit",
						on: ["input"],
						emits: [],
						params: { events: [] },
					},
				],
			});
			if (runtime.orchestration === undefined) {
				throw new Error("orchestration capability missing");
			}
			const runId = await runtime.orchestration.startRun("e2e-smoke", { text: "hi" });
			expect(runId).toMatch(/^orun-/);

			// The enqueued step envelope rode the shared transport.
			const { audioQueueSent } = await import("#/test/cloudflare-workers.ts");
			const envelope = audioQueueSent.at(-1) as JobEnvelope;
			expect(envelope.kind).toBe(orchestrator.ORCHESTRATOR_STEP_KIND);
			expect(envelope.payload).toEqual({ runId });

			// Consumer path: decode + handle — the runner's ambientContext
			// is the REAL app runtime context here (EnvCorrector,
			// PlatformLlm/Decisions, OrchestratorRegistry all bound).
			const payload = registration?.decodePayload?.(envelope.payload);
			await registration?.handle(payload, envelope);
			const record = await orchestrator.getOrchestrationRun(platform.db, runId);
			expect(record?.status).toBe("done");
		},
	);

	it(
		"leaves the kind unregistered and the capability absent without a queue",
		{ timeout: 60_000 },
		async () => {
			const { runtime, jobHandlers, orchestrator } = await compose((env) => {
				env.AUDIO_QUEUE = undefined;
			});
			expect(jobHandlers[orchestrator.ORCHESTRATOR_STEP_KIND]).toBeUndefined();
			expect(runtime.orchestration).toBeUndefined();
			expect(runtime.jobKinds?.()).not.toContain(orchestrator.ORCHESTRATOR_STEP_KIND);
		},
	);
});
