import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Anamnesis } from "@ktb/anamnesis";
import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { LlmPort, PortError, type RunRecord, type TaskEnvelope } from "@ktb/eval-core";
import {
	AnamnesisEngineLive,
	heuristicAnamnesisEngineLive,
	makeAnamnesisEngine,
	parseAnamnesis,
} from "./services.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "./workers-ai.ts";

const mocks = vi.hoisted(() => ({
	anthropicLive: vi.fn(),
	openAiLive: vi.fn(),
}));

vi.mock("./llm.ts", async () => {
	const { LanguageModel } = await import("effect/ai");
	const Effect = await import("effect/Effect");
	const Layer = await import("effect/Layer");
	// Failing LanguageModel — the env LlmPort adapter maps the error
	// to PortError, so every extract lands on the heuristic fallback.
	const failingModel = {
		[LanguageModel.TypeId]: LanguageModel.TypeId,
		generateText: () => Effect.fail(new Error("provider down")),
		generateObject: () => Effect.die("unused"),
		streamText: () => {
			throw new Error("unused");
		},
	} as unknown as import("effect/ai").LanguageModel.LanguageModel;
	const lmLayer = () => Layer.succeed(LanguageModel.LanguageModel, failingModel);
	mocks.anthropicLive.mockImplementation(lmLayer);
	mocks.openAiLive.mockImplementation(lmLayer);
	return {
		anthropicLanguageModelLive: mocks.anthropicLive,
		openAiLanguageModelLive: mocks.openAiLive,
	};
});

/** Captures log entries emitted through Effect.log* inside the effect. */
const captureLogs = () => {
	const entries: { message: unknown; annotations: Record<string, unknown> }[] = [];
	const logger = Logger.make((options) => {
		const message: unknown = options.message;
		entries.push({
			message,
			annotations: Array.isArray(message)
				? ((message[1] as Record<string, unknown> | undefined) ?? {})
				: {},
		});
	});
	return { entries, logger };
};

/** Records every span opened while the effect runs. */
const makeTracer = () => {
	const spans: Tracer.NativeSpan[] = [];
	const tracer = Tracer.make({
		span: (options) => {
			const span = new Tracer.NativeSpan(options);
			spans.push(span);
			return span;
		},
	});
	return { spans, tracer };
};

const section = (content: string) => ({
	content,
	confidence: "alta" as const,
	evidence: ["evidência"],
});

const MOCK_ANAMNESIS: Anamnesis = {
	queixa_principal: section("Dor de cabeça"),
	hda: section("Há 3 dias"),
	antecedentes: section("Nega"),
	alergias: section("Nega"),
	medicamentos_em_uso: section("Nega"),
	exame_fisico: section("N/A"),
	hipoteses: section("Enxaqueca"),
	conduta: section("Dipirona"),
};

const record = (engine: string): RunRecord =>
	({
		runId: "r",
		taskId: "t",
		stage: "generate",
		engine,
		inputHash: "h",
		startedAt: 0,
	}) as RunRecord;

type GenerateOut = { readonly text: string; readonly engine?: string } | Error;

/** Minimal LlmPort fake — generate/correct are the only members the
 * engine exercises. */
const fakeLlmLayer = (generate: (envelope: TaskEnvelope) => GenerateOut) =>
	Layer.succeed(
		LlmPort,
		LlmPort.of({
			generate: (envelope) => {
				const out = generate(envelope);
				return out instanceof Error
					? Effect.fail(new PortError({ port: "llm", message: out.message }))
					: Effect.succeed({
							text: out.text,
							record: record(out.engine ?? "test-engine"),
						});
			},
			correct: () => Effect.fail(new PortError({ port: "llm", message: "unused" })),
		}),
	);

const failingLlmLayer = fakeLlmLayer(() => new Error("provider down"));

const engineFrom = async (layer: Layer.Layer<AnamnesisEngine>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* AnamnesisEngine;
		}).pipe(Effect.provide(layer)),
	);

beforeEach(() => {
	mocks.anthropicLive.mockClear();
	mocks.openAiLive.mockClear();
});

describe("parseAnamnesis", () => {
	it("parses bare JSON and fenced JSON", () => {
		expect(parseAnamnesis(JSON.stringify(MOCK_ANAMNESIS)).queixa_principal.content).toBe(
			"Dor de cabeça",
		);
		expect(
			parseAnamnesis(`\`\`\`json\n${JSON.stringify(MOCK_ANAMNESIS)}\n\`\`\``).hda.content,
		).toBe("Há 3 dias");
	});

	it("parses JSON wrapped in prose", () => {
		const res = parseAnamnesis(`Aqui está:\n${JSON.stringify(MOCK_ANAMNESIS)}\nFim.`);
		expect(res.conduta.content).toBe("Dipirona");
	});

	it("rejects non-JSON output", () => {
		expect(() => parseAnamnesis("not json")).toThrow();
	});
});

describe("AnamnesisEngine", () => {
	it("extracts via the provided LlmPort", async () => {
		const seen: TaskEnvelope[] = [];
		const layer = makeAnamnesisEngine("test").pipe(
			Layer.provide(
				fakeLlmLayer((envelope) => {
					seen.push(envelope);
					return { text: JSON.stringify(MOCK_ANAMNESIS), engine: "test-engine" };
				}),
			),
		);
		const engine = await engineFrom(layer);
		const res = await Effect.runPromise(engine.extract({ transcript: "paciente com dor" }));
		expect(res.engine).toBe("test-engine");
		expect(res.anamnesis.queixa_principal.content).toBe("Dor de cabeça");
		expect(res.anamnesis.historico).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(seen[0]!.taskId).toBe("anamnesis-extract");
		expect(seen[0]!.role).toBe("generator");
		expect(seen[0]!.outputSchema).toBe("Text");
		const input = seen[0]!.input;
		expect(input).toContain("clinical documentation assistant");
		expect(input).toContain("paciente com dor");
	});

	it("sends patient history as prompt context and records it in historico", async () => {
		let sent = "";
		const layer = makeAnamnesisEngine("test").pipe(
			Layer.provide(
				fakeLlmLayer((envelope) => {
					sent = envelope.input;
					return { text: JSON.stringify(MOCK_ANAMNESIS) };
				}),
			),
		);
		const engine = await engineFrom(layer);
		const history = {
			count: 1,
			visits: [
				{
					id: 5,
					date: "2026-03-01T10:00:00.000Z",
					chiefComplaint: "Dor de cabeça",
					plan: "Repouso",
				},
			],
		};
		const res = await Effect.runPromise(engine.extract({ transcript: "retorno", history }));
		expect(res.anamnesis.historico?.content).toContain("Consultas anteriores (1):");
		expect(sent).toContain("PATIENT HISTORY");
		expect(sent).toContain("Dor de cabeça");
	});

	it("falls back to heuristic when the port fails", async () => {
		const layer = makeAnamnesisEngine("openai").pipe(Layer.provide(failingLlmLayer));
		const engine = await engineFrom(layer);
		const { entries, logger } = captureLogs();
		const { spans, tracer } = makeTracer();
		const res = await Effect.runPromise(
			engine
				.extract({ transcript: "paciente relata febre" })
				.pipe(Effect.provideService(Tracer.Tracer, tracer), Effect.provide(Logger.layer([logger]))),
		);
		expect(res.engine).toBe("openai!fallback");
		expect(res.anamnesis.queixa_principal.content).toBeTruthy();
		expect(spans.map((s) => s.name)).toContain("AnamnesisEngine.extract");
		const llmSpan = spans.find((s) => s.name === "anamnesis.llm");
		expect(llmSpan?.attributes.get("anamnesis.engine")).toBe("openai");
		const warn = entries.find((e) => String(e.message).includes("anamnesis extraction failed"));
		expect(warn?.annotations.engine).toBe("openai");
		expect(String(warn?.annotations.error)).toContain("provider down");
	});

	it("falls back to heuristic when the payload is unparseable", async () => {
		const layer = makeAnamnesisEngine("openai").pipe(
			Layer.provide(fakeLlmLayer(() => ({ text: "not json" }))),
		);
		const engine = await engineFrom(layer);
		const res = await Effect.runPromise(engine.extract({ transcript: "paciente relata tosse" }));
		expect(res.engine).toBe("openai!fallback");
		expect(res.anamnesis.queixa_principal.content).toBeTruthy();
	});

	it("heuristic fallback still attaches historico when history is given", async () => {
		const layer = makeAnamnesisEngine("openai").pipe(Layer.provide(failingLlmLayer));
		const engine = await engineFrom(layer);
		const res = await Effect.runPromise(
			engine.extract({
				transcript: "paciente relata tosse",
				history: {
					count: 1,
					visits: [
						{
							id: 2,
							date: "2026-01-01T00:00:00.000Z",
							chiefComplaint: "Tosse",
							plan: null,
						},
					],
				},
			}),
		);
		expect(res.engine).toBe("openai!fallback");
		expect(res.anamnesis.historico?.content).toContain("Consultas anteriores (1):");
	});

	it("heuristic engine extracts without a model", async () => {
		const engine = await engineFrom(heuristicAnamnesisEngineLive);
		const { spans, tracer } = makeTracer();
		const res = await Effect.runPromise(
			engine
				.extract({ transcript: "paciente relata tosse" })
				.pipe(Effect.provideService(Tracer.Tracer, tracer)),
		);
		expect(res.engine).toBe("heuristic");
		expect(spans.map((s) => s.name)).toContain("AnamnesisEngine.extract");
	});
});

describe("AnamnesisEngineLive selection", () => {
	const extract = async (cfg: Parameters<typeof AnamnesisEngineLive>[0]) => {
		const engine = await engineFrom(AnamnesisEngineLive(cfg));
		return Effect.runPromise(engine.extract({ transcript: "t" }));
	};

	it("wires provider options with documented defaults", () => {
		AnamnesisEngineLive({ anthropicApiKey: "k", anthropicModel: "m" });
		expect(mocks.anthropicLive).toHaveBeenLastCalledWith({ apiKey: "k", model: "m" });
		AnamnesisEngineLive({ anthropicApiKey: "k" });
		expect(mocks.anthropicLive).toHaveBeenLastCalledWith({
			apiKey: "k",
			model: "claude-haiku-4-5",
		});
		AnamnesisEngineLive({
			openAiApiKey: "k",
			openAiBaseUrl: "http://x",
			openAiModel: "m",
		});
		expect(mocks.openAiLive).toHaveBeenLastCalledWith({
			apiKey: "k",
			baseUrl: "http://x",
			model: "m",
		});
		AnamnesisEngineLive({ openAiApiKey: "k" });
		expect(mocks.openAiLive).toHaveBeenLastCalledWith({
			apiKey: "k",
			baseUrl: undefined,
			model: "gpt-4o-mini",
		});
	});

	it("prefers anthropic over openai over workers-ai", async () => {
		const ai = { run: vi.fn(async () => ({ response: "{}" })) };
		AnamnesisEngineLive({ anthropicApiKey: "a", openAiApiKey: "o", workersAi: ai });
		expect(mocks.anthropicLive).toHaveBeenCalledOnce();
		expect(mocks.openAiLive).not.toHaveBeenCalled();
		expect(ai.run).not.toHaveBeenCalled();
		AnamnesisEngineLive({ openAiApiKey: "o", workersAi: ai });
		expect(mocks.openAiLive).toHaveBeenCalledOnce();
		expect(ai.run).not.toHaveBeenCalled();
		await extract({ workersAi: ai });
		expect(ai.run).toHaveBeenCalled();
	});

	it("selected engines report their provider tag", async () => {
		expect((await extract({ anthropicApiKey: "k" })).engine).toBe("anthropic!fallback");
		expect((await extract({ openAiApiKey: "k" })).engine).toBe("openai!fallback");
		expect((await extract({})).engine).toBe("heuristic");
	});

	it("workers-ai extracts through its LlmPort with the default model", async () => {
		const ai = { run: vi.fn(async () => ({ response: JSON.stringify(MOCK_ANAMNESIS) })) };
		const res = await extract({ workersAi: ai });
		expect(res.engine).toBe(`workers-ai:${DEFAULT_WORKERS_AI_MODEL}`);
		expect(ai.run).toHaveBeenCalledWith(
			DEFAULT_WORKERS_AI_MODEL,
			expect.objectContaining({ messages: expect.any(Array) }),
		);
	});
});
