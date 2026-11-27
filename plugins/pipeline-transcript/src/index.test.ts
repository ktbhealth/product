import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makePipelineRegistry, type PipelineResult } from "@ktb/pipeline";
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
	plugins,
	transcriptPipelinePack,
	transcriptPipelinePlugin,
	type EnvCorrectorFn,
	type TranscriptCleanupState,
	type TranscriptGateState,
} from "./index.ts";
import { transcriptOrchestrationPack } from "./orchestration.ts";

const record: RunRecord = {
	runId: "r1",
	taskId: "t1",
	stage: "cleanup",
	engine: "stub-llm",
	inputHash: "h",
	startedAt: 0,
};

const decisionRecord: RunRecord = { ...record, stage: "judge", engine: "stub-decisions" };

/** PlatformLlm stub whose defaultLayer resolves to `inner` (or null). */
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

/** DecisionsPort stub answering every noul question with `flag(i)` —
 * true/high-probability flags the segment (score ≥ 0.5), false flags
 * nothing. */
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

/** Run the pack end-to-end over `input` with `env` as the ambient
 * context (Platform* stubs live there; the stage Effect.provide's the
 * resolved port layers itself). */
const run = <R>(
	input: unknown,
	env: Layer.Layer<R, never, never>,
	config?: Record<string, unknown>,
) => {
	const registry = makePipelineRegistry();
	registry.register(transcriptPipelinePack);
	return Effect.runPromise(
		registry.run("consultation-transcript", input, config).pipe(Effect.provide(env)),
	);
};

const gateOf = (r: PipelineResult): TranscriptGateState | undefined =>
	r.state.gate as TranscriptGateState | undefined;
const cleanupOf = (r: PipelineResult): TranscriptCleanupState | undefined =>
	r.state.cleanup as TranscriptCleanupState | undefined;

describe("transcriptPipelinePack", () => {
	it("skips both stages when no platform endpoints are bound", async () => {
		const r = await run({ text: "Bom dia. Como vai?" }, Layer.empty);
		expect(gateOf(r)?.enabled).toBe(false);
		expect(cleanupOf(r)?.enabled).toBe(false);
		expect(r.trace.map((t) => t.status)).toEqual(["ok", "ok", "ok"]);
	});

	it("runs ungated cleanup when the decision endpoint is absent", async () => {
		const seen: string[] = [];
		const env = Layer.mergeAll(
			platformLlm(
				llmLayer((envelope) =>
					Effect.sync(() => {
						seen.push(envelope.input);
						return { edits: { ops: [] }, record };
					}),
				),
			),
		);
		const r = await run({ text: "texto cru", taskId: "eval-1" }, env);
		// No PlatformDecisions → gate disabled → whole-transcript correct.
		expect(gateOf(r)?.enabled).toBe(false);
		const cleanup = cleanupOf(r);
		expect(cleanup?.enabled).toBe(true);
		expect(cleanup?.corrected).toBe("texto cru");
		expect(cleanup?.engine).toBe("stub-llm");
		expect(cleanup?.records).toHaveLength(1);
		expect(seen).toEqual(["texto cru"]);
	});

	it("scopes cleanup to flagged char ranges when the gate fires", async () => {
		const text = "Bom dia. Tudo bem? Erro feio XA aqui.";
		const segments = [{ text: "Bom dia." }, { text: "Tudo bem?" }, { text: "Erro feio XA aqui." }];
		const seen: string[] = [];
		// Flag ONLY segment index 2 (the third question batch position is
		// per-segment within a batch — one batch here, flag(i) hits i===2).
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
		const r = await run({ text, segments, taskId: "eval-2" }, env);
		const gate = gateOf(r);
		expect(gate?.enabled).toBe(true);
		// Char span covers exactly the third segment's occurrence.
		expect(gate?.ranges).toEqual([{ start: text.indexOf("Erro feio"), end: text.length }]);
		const cleanup = cleanupOf(r);
		expect(cleanup?.enabled).toBe(true);
		// Gated path: the corrector saw ONLY the flagged slice.
		expect(seen).toEqual(["Erro feio XA aqui."]);
		expect(cleanup?.corrected).toBe(text);
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
		const r = await run({ text: "texto cru", segments: [{ text: "texto cru" }] }, env);
		expect(gateOf(r)?.enabled).toBe(true);
		expect(gateOf(r)?.ranges).toEqual([]);
		expect(cleanupOf(r)?.enabled).toBe(true);
		expect(seen).toEqual(["texto cru"]);
	});

	it("degrades to disabled cleanup when the corrector fails", async () => {
		const env = platformLlm(
			llmLayer(() => Effect.fail(new PortError({ port: "llm", message: "down" }))),
		);
		const r = await run({ text: "texto cru" }, env);
		expect(cleanupOf(r)?.enabled).toBe(false);
		expect(cleanupOf(r)?.error).toBe("cleanup-failed");
	});

	it("treats malformed input as disabled, never a failed run", async () => {
		const env = Layer.mergeAll(
			platformDecisions(decisionsLayer(() => true)),
			platformLlm(llmLayer(() => Effect.succeed({ edits: { ops: [] }, record }))),
		);
		const r = await run({ nope: true }, env);
		expect(gateOf(r)?.enabled).toBe(false);
		expect(cleanupOf(r)?.enabled).toBe(false);
	});
});

describe("asr-gate segment contract", () => {
	it("disables with no-segments when the provider returned text only", async () => {
		const env = platformDecisions(decisionsLayer(() => true));
		const r = await run({ text: "texto cru" }, env);
		expect(gateOf(r)?.enabled).toBe(false);
		expect(gateOf(r)?.error).toBe("no-segments");
	});
});

describe("env-cleanup fallback stage", () => {
	/** Stub env corrector — the composition root injects a ready
	 * function (app-host wires anamnesis-llm's correctTranscript);
	 * plugins never see LlmConfig. */
	const envCorrect =
		(corrected: string, engine = "workers-ai"): EnvCorrectorFn =>
		() =>
			Effect.succeed({ corrected, engine });

	it("corrects through the injected env corrector when no platform endpoint is bound", async () => {
		const seen: string[] = [];
		const corrector: EnvCorrectorFn = (text) =>
			Effect.sync(() => {
				seen.push(text);
				return { corrected: "Texto corrigido.", engine: "workers-ai" };
			});
		const r = await run({ text: "texto cru" }, Layer.empty, {
			[ENV_CORRECTOR_KEY]: corrector,
		});
		const cleanup = cleanupOf(r);
		expect(cleanup?.enabled).toBe(true);
		expect(cleanup?.corrected).toBe("Texto corrigido.");
		expect(cleanup?.engine).toBe("workers-ai");
		expect(seen).toEqual(["texto cru"]);
	});

	it("stays disabled without an envCorrect run config", async () => {
		const r = await run({ text: "texto cru" }, Layer.empty);
		expect(cleanupOf(r)?.enabled).toBe(false);
	});

	it("stays disabled when the injected corrector returns null", async () => {
		const r = await run({ text: "texto cru" }, Layer.empty, {
			[ENV_CORRECTOR_KEY]: () => Effect.succeed(null),
		});
		expect(cleanupOf(r)?.enabled).toBe(false);
	});

	it("stays disabled when the injected corrector fails", async () => {
		const r = await run({ text: "texto cru" }, Layer.empty, {
			[ENV_CORRECTOR_KEY]: () => Effect.fail(new PortError({ port: "llm", message: "down" })),
		});
		expect(cleanupOf(r)?.enabled).toBe(false);
	});

	it("never overrides a successful platform cleanup", async () => {
		const envCalls: string[] = [];
		const corrector: EnvCorrectorFn = (text) =>
			Effect.sync(() => {
				envCalls.push(text);
				return { corrected: "NAO DEVE APARECER", engine: "workers-ai" };
			});
		const env = platformLlm(llmLayer(() => Effect.succeed({ edits: { ops: [] }, record })));
		const r = await run({ text: "texto cru", segments: [{ text: "texto cru" }] }, env, {
			[ENV_CORRECTOR_KEY]: corrector,
		});
		const cleanup = cleanupOf(r);
		expect(cleanup?.enabled).toBe(true);
		expect(cleanup?.engine).toBe("stub-llm");
		expect(envCalls).toEqual([]);
	});

	it("envCorrect helper builds a constant-result corrector", async () => {
		const r = await run({ text: "texto cru" }, Layer.empty, {
			[ENV_CORRECTOR_KEY]: envCorrect("via helper", "env-x"),
		});
		expect(cleanupOf(r)).toMatchObject({ enabled: true, corrected: "via helper", engine: "env-x" });
	});

	it("corrects through the ambient EnvCorrector port when bound", async () => {
		const seen: string[] = [];
		const corrector: EnvCorrectorFn = (text) =>
			Effect.sync(() => {
				seen.push(text);
				return { corrected: "Port corrigido.", engine: "port-x" };
			});
		const env = Layer.succeed(EnvCorrector, { correct: corrector });
		const r = await run({ text: "texto cru" }, env);
		expect(cleanupOf(r)).toMatchObject({
			enabled: true,
			corrected: "Port corrigido.",
			engine: "port-x",
		});
		expect(seen).toEqual(["texto cru"]);
	});

	it("prefers the ambient port over the run-config function", async () => {
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
		const r = await run({ text: "texto cru" }, env, {
			[ENV_CORRECTOR_KEY]: configCorrector,
		});
		expect(cleanupOf(r)).toMatchObject({ enabled: true, corrected: "via port", engine: "port-x" });
		expect(portCalls).toEqual(["texto cru"]);
		expect(configCalls).toEqual([]);
	});

	it("stays disabled when the port corrector returns null or fails", async () => {
		const nullEnv = Layer.succeed(EnvCorrector, { correct: () => Effect.succeed(null) });
		const rNull = await run({ text: "texto cru" }, nullEnv);
		expect(cleanupOf(rNull)?.enabled).toBe(false);
		const failEnv = Layer.succeed(EnvCorrector, {
			correct: () => Effect.fail(new PortError({ port: "llm", message: "down" })),
		});
		const rFail = await run({ text: "texto cru" }, failEnv);
		expect(cleanupOf(rFail)?.enabled).toBe(false);
	});

	it("marks state[env-cleanup] skipped when correction is needed but no corrector is bound", async () => {
		const r = await run({ text: "texto cru" }, Layer.empty);
		expect(r.state["env-cleanup"]).toEqual({ skipped: true, reason: "no-port" });
		expect(cleanupOf(r)?.enabled).toBe(false);
	});
});

describe("platform layer resolution degrades", () => {
	/** Platform* stubs whose defaultLayer is an arbitrary effect —
	 * typed failure and defect both must land on the disabled path. */
	const platformDecisionsFx = (fx: Effect.Effect<unknown, unknown, unknown>) =>
		Layer.succeed(PlatformDecisions, PlatformDecisions.of({ defaultLayer: () => fx as never }));
	const platformLlmFx = (fx: Effect.Effect<unknown, unknown, unknown>) =>
		Layer.succeed(PlatformLlm, PlatformLlm.of({ defaultLayer: () => fx as never }));

	it("disables the gate when defaultLayer fails or defects", async () => {
		const input = { text: "um dois", segments: [{ text: "um" }, { text: "dois" }] };
		const rFail = await run(
			input,
			platformDecisionsFx(Effect.fail(new PortError({ port: "decisions", message: "down" }))),
		);
		expect(gateOf(rFail)?.enabled).toBe(false);
		const rDie = await run(input, platformDecisionsFx(Effect.die("defect")));
		expect(gateOf(rDie)?.enabled).toBe(false);
	});

	it("disables cleanup when defaultLayer fails or defects", async () => {
		const rFail = await run(
			{ text: "texto cru" },
			platformLlmFx(Effect.fail(new PortError({ port: "llm", message: "down" }))),
		);
		expect(cleanupOf(rFail)?.enabled).toBe(false);
		const rDie = await run({ text: "texto cru" }, platformLlmFx(Effect.die("defect")));
		expect(cleanupOf(rDie)?.enabled).toBe(false);
	});
});

describe("asr-gate detection failures", () => {
	const judgeLayer = (judge: DecisionsPort["Service"]["judge"]): Layer.Layer<DecisionsPort> =>
		Layer.succeed(DecisionsPort, DecisionsPort.of({ judge }));
	const input = { text: "um dois", segments: [{ text: "um" }, { text: "dois" }] };

	it("disables with detection-failed when the judge call fails", async () => {
		const env = platformDecisions(
			judgeLayer(() => Effect.fail(new PortError({ port: "decisions", message: "judge down" }))),
		);
		const r = await run(input, env);
		expect(gateOf(r)).toMatchObject({ enabled: false, error: "detection-failed" });
	});

	it("disables with detection-failed when the judge call defects", async () => {
		const env = platformDecisions(judgeLayer(() => Effect.die("judge defect")));
		const r = await run(input, env);
		expect(gateOf(r)).toMatchObject({ enabled: false, error: "detection-failed" });
	});
});

describe("llm-cleanup corrector defects", () => {
	it("disables with cleanup-failed when the correct call defects", async () => {
		const env = platformLlm(llmLayer(() => Effect.die("corrector defect")));
		const r = await run({ text: "texto cru" }, env);
		expect(cleanupOf(r)).toMatchObject({ enabled: false, error: "cleanup-failed" });
	});

	it("reports engine 'unknown' when the corrector record omits it", async () => {
		const noEngine = { ...record, engine: undefined } as unknown as RunRecord;
		const env = platformLlm(
			llmLayer(() => Effect.succeed({ edits: { ops: [] }, record: noEngine })),
		);
		const r = await run({ text: "texto cru" }, env);
		expect(cleanupOf(r)).toMatchObject({ enabled: true, engine: "unknown" });
	});
});

describe("wire input narrowing", () => {
	it("treats non-object input as disabled across every stage", async () => {
		const env = Layer.mergeAll(
			platformDecisions(decisionsLayer(() => false)),
			platformLlm(llmLayer(() => Effect.succeed({ edits: { ops: [] }, record }))),
		);
		const r = await run(null, env, { [ENV_CORRECTOR_KEY]: () => Effect.succeed(null) });
		expect(gateOf(r)?.enabled).toBe(false);
		expect(cleanupOf(r)?.enabled).toBe(false);
	});

	it("env-cleanup ignores invalid input even with a corrector configured", async () => {
		const corrector: EnvCorrectorFn = () => Effect.succeed({ corrected: "x", engine: "e" });
		const r = await run({ text: "   " }, Layer.empty, {
			[ENV_CORRECTOR_KEY]: corrector,
		});
		expect(cleanupOf(r)?.enabled).toBe(false);
	});
});

describe("env-cleanup corrector defects", () => {
	it("stays disabled when the injected corrector defects", async () => {
		const r = await run({ text: "texto cru" }, Layer.empty, {
			[ENV_CORRECTOR_KEY]: () => Effect.die("corrector defect"),
		});
		expect(cleanupOf(r)?.enabled).toBe(false);
	});
});

describe("pipeline.transcript manifest", () => {
	it("contributes the consultation-transcript pack on both engines", () => {
		expect(plugins.map((p) => p.id)).toEqual(["pipeline.transcript"]);
		expect(plugins[0]?.pipelines).toEqual([transcriptPipelinePack]);
		expect(plugins[0]?.orchestrations).toEqual([transcriptOrchestrationPack]);
		expect(transcriptPipelinePlugin.id).toBe("pipeline.transcript");
		expect(transcriptPipelinePack.def.id).toBe("consultation-transcript");
		expect(transcriptPipelinePack.def.stages.map((s) => s.id)).toEqual([
			"asr-gate",
			"llm-cleanup",
			"env-cleanup",
		]);
		// Every stage degrades gracefully — never halt the run.
		expect(transcriptPipelinePack.def.stages.every((s) => s.onError === "skip")).toBe(true);
	});
});
