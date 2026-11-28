import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { JsonObject } from "effect/Schema";

import { makePipelineRegistry, type PipelineResult } from "@ktb/pipeline";
import {
	OrchestratorRegistry,
	type OrchestrationDef,
	type OrchestrationKind,
	type OrchestrationRunResult,
} from "@ktb/orchestrator";
import {
	DecisionsPort,
	LlmPort,
	PlatformDecisions,
	PlatformLlm,
	PortError,
	type RunRecord,
} from "@ktb/eval-core";

import {
	ENV_CORRECTOR_KEY,
	EnvCorrector,
	transcriptPipelinePack,
	type EnvCorrectorFn,
	type TranscriptCleanupState,
	type TranscriptGateState,
} from "./index.ts";
import {
	makeTranscriptOrchestratorRegistry,
	runTranscriptOrchestration,
	transcriptOrchestrationConfig,
	transcriptOrchestrationDef,
	transcriptOrchestrationKinds,
	transcriptOrchestrationPack,
	transcriptOrchestratorRegistryLive,
} from "./orchestration.ts";

/**
 * Parity suite (P-120 phase 5): every scenario runs the SAME fixture
 * through BOTH engines — the `consultation-transcript` PipelinePack on
 * PipelineRegistry and the OrchestrationDef on OrchestratorRegistry —
 * and asserts the observable contract matches: `state.gate`,
 * `state.cleanup`, the per-stage `state[stageId]` aliases, the run
 * status, and the typed event chain. The stage implementations are
 * shared by construction (the orchestration def is DERIVED from the
 * pack via `pipelinePackToOrchestration` — the adapted kinds invoke
 * the same pack.stages entries), so these tests pin the ADAPTER
 * semantics: input forwarding, state merging, skip-on-failure
 * continuation, env-corrector config.
 */

const record: RunRecord = {
	runId: "r1",
	taskId: "t1",
	stage: "cleanup",
	engine: "stub-llm",
	inputHash: "h",
	startedAt: 0,
};

const decisionRecord: RunRecord = { ...record, stage: "judge", engine: "stub-decisions" };

const platformLlm = (inner: Layer.Layer<LlmPort> | null) =>
	Layer.succeed(PlatformLlm, PlatformLlm.of({ defaultLayer: () => Effect.succeed(inner) }));

const platformDecisions = (inner: Layer.Layer<DecisionsPort> | null) =>
	Layer.succeed(
		PlatformDecisions,
		PlatformDecisions.of({ defaultLayer: () => Effect.succeed(inner) }),
	);

const llmLayer = (correct: LlmPort["Service"]["correct"]): Layer.Layer<LlmPort> =>
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			generate: () => Effect.succeed({ text: "", record }),
			correct,
		}),
	);

const decisionsLayer = (flag: (index: number) => boolean): Layer.Layer<DecisionsPort> =>
	Layer.succeed(
		DecisionsPort,
		DecisionsPort.of({
			judge: ({ questions }) =>
				Effect.succeed({
					answers: questions.map((q, i) => ({
						id: q.id,
						kind: q.kind,
						value: flag(i),
						probability: 0.9,
					})),
					record: decisionRecord,
				}),
		}),
	);

const correctorStub =
	(corrected: string, engine = "workers-ai"): EnvCorrectorFn =>
	() =>
		Effect.succeed({ corrected, engine });

/** Run one fixture through both engines over the same ambient env.
 * `config` is the pipeline run config verbatim (envCorrect etc.) —
 * the orchestration side receives it as `RunOptions.config` (the
 * JsonObject cast is what production callers do too; see
 * transcriptOrchestrationConfig). */
const runBoth = <R>(
	input: unknown,
	env: Layer.Layer<R, never, never>,
	config?: Record<string, unknown>,
): Promise<{ pipeline: PipelineResult; orchestration: OrchestrationRunResult }> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const preg = makePipelineRegistry();
			preg.register(transcriptPipelinePack);
			const oreg = makeTranscriptOrchestratorRegistry();
			const [pipeline, orchestration] = yield* Effect.all(
				[
					preg.run("consultation-transcript", input, config),
					oreg.run("consultation-transcript", input, {
						config: config as JsonObject | undefined,
					}),
				],
				{ concurrency: 2 },
			);
			return { pipeline, orchestration };
		}).pipe(Effect.provide(env)),
	);

const gateOf = (state: Readonly<Record<string, unknown>>): TranscriptGateState | undefined =>
	state.gate as TranscriptGateState | undefined;
const cleanupOf = (state: Readonly<Record<string, unknown>>): TranscriptCleanupState | undefined =>
	state.cleanup as TranscriptCleanupState | undefined;

/** The parity contract: identical gate/cleanup fragments AND the
 * per-stage aliases the pipeline runner writes at state[stageId]. */
const expectStateParity = (
	pipeline: PipelineResult,
	orchestration: OrchestrationRunResult,
): void => {
	expect(orchestration.status).toBe("done");
	// Identical key sets — no leaked node bookkeeping into run state.
	expect(Object.keys(orchestration.state).sort()).toEqual(Object.keys(pipeline.state).sort());
	expect(gateOf(orchestration.state)).toEqual(gateOf(pipeline.state));
	expect(cleanupOf(orchestration.state)).toEqual(cleanupOf(pipeline.state));
	for (const stageId of ["asr-gate", "llm-cleanup", "env-cleanup"]) {
		expect(orchestration.state[stageId]).toEqual(pipeline.state[stageId]);
	}
};

/** The event chain the derived def declares — input →
 * <stage>.done per stage → workflow.done, in order, nothing else.
 * Event types come from the @ktb/pipeline bridge convention
 * (`${defId}.${stageId}.done`). */
const expectEventChain = (orchestration: OrchestrationRunResult): void => {
	expect(orchestration.events.map((e) => e.type)).toEqual([
		"input",
		"consultation-transcript.asr-gate.done",
		"consultation-transcript.llm-cleanup.done",
		"consultation-transcript.env-cleanup.done",
		"workflow.done",
	]);
	expect(orchestration.trace.map((t) => t.nodeId)).toEqual([
		"asr-gate",
		"llm-cleanup",
		"env-cleanup",
	]);
	expect(orchestration.trace.every((t) => t.status === "ok")).toBe(true);
};

describe("consultation-transcript orchestration parity", () => {
	it("disables both stages when no platform endpoints are bound", async () => {
		const { pipeline, orchestration } = await runBoth({ text: "Bom dia. Como vai?" }, Layer.empty);
		expectStateParity(pipeline, orchestration);
		expectEventChain(orchestration);
		expect(gateOf(orchestration.state)?.enabled).toBe(false);
		expect(cleanupOf(orchestration.state)?.enabled).toBe(false);
	});

	it("runs ungated cleanup when the decision endpoint is absent", async () => {
		const seen: string[] = [];
		const env = platformLlm(
			llmLayer((envelope) =>
				Effect.sync(() => {
					seen.push(envelope.input);
					return { edits: { ops: [] }, record };
				}),
			),
		);
		const { pipeline, orchestration } = await runBoth({ text: "texto cru", taskId: "eval-1" }, env);
		expectStateParity(pipeline, orchestration);
		expectEventChain(orchestration);
		expect(cleanupOf(orchestration.state)).toMatchObject({
			enabled: true,
			corrected: "texto cru",
			engine: "stub-llm",
		});
		expect(seen).toEqual(["texto cru", "texto cru"]);
	});

	it("scopes cleanup to flagged char ranges when the gate fires", async () => {
		const text = "Bom dia. Tudo bem? Erro feio XA aqui.";
		const segments = [{ text: "Bom dia." }, { text: "Tudo bem?" }, { text: "Erro feio XA aqui." }];
		const seen: string[] = [];
		const env = Layer.mergeAll(
			platformDecisions(decisionsLayer((i) => i === 2)),
			platformLlm(
				llmLayer((envelope) =>
					Effect.sync(() => {
						seen.push(envelope.input);
						return { edits: { ops: [] }, record };
					}),
				),
			),
		);
		const { pipeline, orchestration } = await runBoth({ text, segments, taskId: "eval-2" }, env);
		expectStateParity(pipeline, orchestration);
		expectEventChain(orchestration);
		expect(gateOf(orchestration.state)?.ranges).toEqual([
			{ start: text.indexOf("Erro feio"), end: text.length },
		]);
		expect(seen).toEqual(["Erro feio XA aqui.", "Erro feio XA aqui."]);
	});

	it("falls back to ungated cleanup when the gate flags nothing", async () => {
		const seen: string[] = [];
		const env = Layer.mergeAll(
			platformDecisions(decisionsLayer(() => false)),
			platformLlm(
				llmLayer((envelope) =>
					Effect.sync(() => {
						seen.push(envelope.input);
						return { edits: { ops: [] }, record };
					}),
				),
			),
		);
		const { pipeline, orchestration } = await runBoth(
			{ text: "texto cru", segments: [{ text: "texto cru" }] },
			env,
		);
		expectStateParity(pipeline, orchestration);
		expect(gateOf(orchestration.state)?.ranges).toEqual([]);
		expect(seen).toEqual(["texto cru", "texto cru"]);
	});

	it("degrades to disabled cleanup when the corrector fails", async () => {
		const env = platformLlm(
			llmLayer(() => Effect.fail(new PortError({ port: "llm", message: "down" }))),
		);
		const { pipeline, orchestration } = await runBoth({ text: "texto cru" }, env);
		expectStateParity(pipeline, orchestration);
		expect(cleanupOf(orchestration.state)).toMatchObject({
			enabled: false,
			error: "cleanup-failed",
		});
	});

	it("treats malformed input as disabled, never a failed run", async () => {
		const env = Layer.mergeAll(
			platformDecisions(decisionsLayer(() => true)),
			platformLlm(llmLayer(() => Effect.succeed({ edits: { ops: [] }, record }))),
		);
		const { pipeline, orchestration } = await runBoth({ nope: true }, env);
		expectStateParity(pipeline, orchestration);
		expect(orchestration.status).toBe("done");
	});

	it("disables the gate with no-segments on text-only input", async () => {
		const env = platformDecisions(decisionsLayer(() => true));
		const { pipeline, orchestration } = await runBoth({ text: "texto cru" }, env);
		expectStateParity(pipeline, orchestration);
		expect(gateOf(orchestration.state)).toMatchObject({
			enabled: false,
			error: "no-segments",
		});
	});
});

describe("env-cleanup fallback parity", () => {
	it("corrects through the injected env corrector when no platform endpoint is bound", async () => {
		const seen: string[] = [];
		const envCorrect: EnvCorrectorFn = (text) =>
			Effect.sync(() => {
				seen.push(text);
				return { corrected: "Texto corrigido.", engine: "workers-ai" };
			});
		const config = { [ENV_CORRECTOR_KEY]: envCorrect };
		const { pipeline, orchestration } = await runBoth({ text: "texto cru" }, Layer.empty, config);
		expectStateParity(pipeline, orchestration);
		expect(cleanupOf(orchestration.state)).toMatchObject({
			enabled: true,
			corrected: "Texto corrigido.",
			engine: "workers-ai",
		});
		// The env corrector ran exactly once per engine.
		expect(seen).toEqual(["texto cru", "texto cru"]);
	});

	it("never overrides a successful platform cleanup", async () => {
		const envCalls: string[] = [];
		const envCorrect: EnvCorrectorFn = (text) =>
			Effect.sync(() => {
				envCalls.push(text);
				return { corrected: "NAO DEVE APARECER", engine: "workers-ai" };
			});
		const env = platformLlm(llmLayer(() => Effect.succeed({ edits: { ops: [] }, record })));
		const config = { [ENV_CORRECTOR_KEY]: envCorrect };
		const { pipeline, orchestration } = await runBoth(
			{ text: "texto cru", segments: [{ text: "texto cru" }] },
			env,
			config,
		);
		expectStateParity(pipeline, orchestration);
		expect(cleanupOf(orchestration.state)?.engine).toBe("stub-llm");
		expect(envCalls).toEqual([]);
	});

	it("stays disabled without an envCorrect run config", async () => {
		const { pipeline, orchestration } = await runBoth({ text: "texto cru" }, Layer.empty);
		expectStateParity(pipeline, orchestration);
		expect(cleanupOf(orchestration.state)?.enabled).toBe(false);
	});

	it("corrects through the ambient EnvCorrector port on both engines", async () => {
		// The port is the durable-safe binding — provideService/ambient
		// context reaches the shared stage on the pipeline engine and
		// the orchestration kinds alike.
		const seen: string[] = [];
		const corrector: EnvCorrectorFn = (text) =>
			Effect.sync(() => {
				seen.push(text);
				return { corrected: "Port corrigido.", engine: "port-x" };
			});
		const env = Layer.succeed(EnvCorrector, { correct: corrector });
		const { pipeline, orchestration } = await runBoth({ text: "texto cru" }, env);
		expectStateParity(pipeline, orchestration);
		expect(cleanupOf(orchestration.state)).toMatchObject({
			enabled: true,
			corrected: "Port corrigido.",
			engine: "port-x",
		});
		// Once per engine.
		expect(seen).toEqual(["texto cru", "texto cru"]);
	});

	it("prefers the ambient port over the run-config function on both engines", async () => {
		const portCalls: string[] = [];
		const configCalls: string[] = [];
		const env = Layer.succeed(EnvCorrector, {
			correct: (text) =>
				Effect.sync(() => {
					portCalls.push(text);
					return { corrected: "via port", engine: "port-x" };
				}),
		});
		const configCorrector: EnvCorrectorFn = (text) =>
			Effect.sync(() => {
				configCalls.push(text);
				return { corrected: "via config", engine: "cfg-x" };
			});
		const config = { [ENV_CORRECTOR_KEY]: configCorrector };
		const { pipeline, orchestration } = await runBoth({ text: "texto cru" }, env, config);
		expectStateParity(pipeline, orchestration);
		expect(cleanupOf(orchestration.state)).toMatchObject({
			enabled: true,
			corrected: "via port",
			engine: "port-x",
		});
		expect(portCalls).toEqual(["texto cru", "texto cru"]);
		expect(configCalls).toEqual([]);
	});
});

describe("orchestration wiring", () => {
	it("registers def + kinds and resolves the same id as the pack", () => {
		expect(transcriptOrchestrationDef.id).toBe("consultation-transcript");
		expect(transcriptOrchestrationPack.def).toBe(transcriptOrchestrationDef);
		expect(transcriptOrchestrationKinds.map((k) => k.id)).toEqual([
			"pipeline.consultation-transcript.asr-gate",
			"pipeline.consultation-transcript.llm-cleanup",
			"pipeline.consultation-transcript.env-cleanup",
		]);
		const registry = makeTranscriptOrchestratorRegistry();
		expect(registry.has("consultation-transcript")).toBe(true);
		expect(registry.get("consultation-transcript")).toBe(transcriptOrchestrationDef);
	});

	it("accepts a bare run() with no input — degrades like a bad-input pipeline run", async () => {
		const r = await Effect.runPromise(runTranscriptOrchestration(undefined));
		expect(r.status).toBe("done");
		expect(gateOf(r.state)?.enabled).toBe(false);
		expect(cleanupOf(r.state)?.enabled).toBe(false);
	});

	it("transcriptOrchestrationConfig wraps the env corrector under ENV_CORRECTOR_KEY", async () => {
		const corrector = correctorStub("via helper", "env-x");
		const config = transcriptOrchestrationConfig(corrector);
		expect(config[ENV_CORRECTOR_KEY]).toBe(corrector);
		const r = await Effect.runPromise(
			runTranscriptOrchestration({ text: "texto cru" }, config as Record<string, unknown>),
		);
		expect(cleanupOf(r.state)).toMatchObject({
			enabled: true,
			corrected: "via helper",
			engine: "env-x",
		});
	});

	it("transcriptOrchestrationConfig() yields an empty config without a corrector", () => {
		expect(transcriptOrchestrationConfig()).toEqual({});
		expect(transcriptOrchestrationConfig(undefined)).toEqual({});
	});

	it("transcriptOrchestratorRegistryLive builds a runnable registry layer", async () => {
		const program = Effect.gen(function* () {
			const registry = yield* OrchestratorRegistry;
			return yield* registry.run("consultation-transcript", { text: "texto cru" });
		});
		const r = await Effect.runPromise(
			program.pipe(Effect.provide(transcriptOrchestratorRegistryLive())),
		);
		expect(r.status).toBe("done");
		expect(cleanupOf(r.state)?.enabled).toBe(false);
	});

	it("transcriptOrchestratorRegistryLive accepts extra kinds and defs", async () => {
		const extraKind: OrchestrationKind = {
			id: "t.probe",
			run: () => Effect.succeed({}),
		};
		const extraDef: OrchestrationDef = {
			id: "probe-orch",
			nodes: [{ id: "n", kind: "t.probe", on: ["input"], emits: [] }],
		};
		const program = Effect.gen(function* () {
			const registry = yield* OrchestratorRegistry;
			return yield* registry.run("probe-orch", { text: "x" });
		});
		const r = await Effect.runPromise(
			program.pipe(Effect.provide(transcriptOrchestratorRegistryLive([extraKind], [extraDef]))),
		);
		expect(r.status).toBe("done");
	});
});
