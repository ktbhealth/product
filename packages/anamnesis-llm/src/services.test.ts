import { LanguageModel } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Anamnesis } from "@ktb/anamnesis";
import { AnamnesisEngine } from "@ktb/anamnesis/services";
import {
	AnamnesisEngineLive,
	heuristicAnamnesisEngineLive,
	makeAnamnesisEngine,
} from "./services.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "./workers-ai.ts";

const mocks = vi.hoisted(() => ({
	anthropicLive: vi.fn(),
	openAiLive: vi.fn(),
	workersAiEngine: vi.fn(),
}));

vi.mock("./llm.ts", () => ({
	anthropicLanguageModelLive: mocks.anthropicLive,
	openAiLanguageModelLive: mocks.openAiLive,
}));

vi.mock("./workers-ai.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./workers-ai.ts")>();
	const Layer = await import("effect/Layer");
	mocks.workersAiEngine.mockReturnValue(Layer.empty);
	return { ...actual, makeWorkersAiAnamnesisEngine: mocks.workersAiEngine };
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

/** Minimal LanguageModel fake — only generateObject is exercised. */
const fakeModel = (
	generateObject: LanguageModel.LanguageModel["generateObject"],
): LanguageModel.LanguageModel =>
	({
		[LanguageModel.TypeId]: LanguageModel.TypeId,
		generateText: () => Effect.die("unused"),
		generateObject,
		streamText: () => {
			throw new Error("unused");
		},
	}) as unknown as LanguageModel.LanguageModel;

const okObject = <A>(value: A) =>
	vi.fn(
		() =>
			Effect.succeed(
				new LanguageModel.GenerateObjectResponse(value as never, [] as never),
			) as never,
	);

const failingModel = () => fakeModel((() => Effect.fail(new Error("provider down"))) as never);

const lmLayer = () => Layer.succeed(LanguageModel.LanguageModel, failingModel());

beforeEach(() => {
	mocks.anthropicLive.mockReset().mockImplementation(lmLayer);
	mocks.openAiLive.mockReset().mockImplementation(lmLayer);
	mocks.workersAiEngine.mockReset().mockReturnValue(Layer.empty);
});

describe("AnamnesisEngine", () => {
	it("extracts via the provided LanguageModel", async () => {
		const gen = okObject(MOCK_ANAMNESIS);
		const layer = makeAnamnesisEngine("test").pipe(
			Layer.provide(Layer.succeed(LanguageModel.LanguageModel, fakeModel(gen))),
		);
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(Effect.provide(layer)),
		);
		const res = await Effect.runPromise(engine.extract({ transcript: "paciente com dor" }));
		expect(res.engine).toBe("test");
		expect(res.anamnesis.queixa_principal.content).toBe("Dor de cabeça");
		expect(res.anamnesis.historico).toBeUndefined();
		expect(gen).toHaveBeenCalledOnce();
		const call = (gen.mock.calls as unknown as [[{ objectName: string; prompt: unknown }]])[0]![0];
		expect(call.objectName).toBe("anamnesis");
		const promptJson = JSON.stringify(call.prompt);
		expect(promptJson).toContain("clinical documentation assistant");
		expect(promptJson).toContain("paciente com dor");
	});

	it("sends patient history as prompt context and records it in historico", async () => {
		const gen = okObject(MOCK_ANAMNESIS);
		const layer = makeAnamnesisEngine("test").pipe(
			Layer.provide(Layer.succeed(LanguageModel.LanguageModel, fakeModel(gen))),
		);
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(Effect.provide(layer)),
		);
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
		const call = (gen.mock.calls as unknown as [[{ prompt: unknown }]])[0]![0];
		expect(JSON.stringify(call.prompt)).toContain("PATIENT HISTORY");
		expect(JSON.stringify(call.prompt)).toContain("Dor de cabeça");
	});

	it("falls back to heuristic when the model fails", async () => {
		const layer = makeAnamnesisEngine("openai").pipe(
			Layer.provide(Layer.succeed(LanguageModel.LanguageModel, failingModel())),
		);
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(Effect.provide(layer)),
		);
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

	it("heuristic fallback still attaches historico when history is given", async () => {
		const layer = makeAnamnesisEngine("openai").pipe(
			Layer.provide(Layer.succeed(LanguageModel.LanguageModel, failingModel())),
		);
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(Effect.provide(layer)),
		);
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
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(Effect.provide(heuristicAnamnesisEngineLive)),
		);
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
	const fakeAi = { run: async () => ({ response: "{}" }) };

	const extract = async (cfg: Parameters<typeof AnamnesisEngineLive>[0]) => {
		const engine = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* AnamnesisEngine;
			}).pipe(Effect.provide(AnamnesisEngineLive(cfg))),
		);
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
		AnamnesisEngineLive({ workersAi: fakeAi });
		expect(mocks.workersAiEngine).toHaveBeenLastCalledWith(fakeAi, DEFAULT_WORKERS_AI_MODEL);
		AnamnesisEngineLive({ workersAi: fakeAi, workersAiModel: "m" });
		expect(mocks.workersAiEngine).toHaveBeenLastCalledWith(fakeAi, "m");
	});

	it("prefers anthropic over openai over workers-ai", () => {
		AnamnesisEngineLive({ anthropicApiKey: "a", openAiApiKey: "o", workersAi: fakeAi });
		expect(mocks.anthropicLive).toHaveBeenCalledOnce();
		expect(mocks.openAiLive).not.toHaveBeenCalled();
		expect(mocks.workersAiEngine).not.toHaveBeenCalled();
		AnamnesisEngineLive({ openAiApiKey: "o", workersAi: fakeAi });
		expect(mocks.openAiLive).toHaveBeenCalledOnce();
		expect(mocks.workersAiEngine).not.toHaveBeenCalled();
		AnamnesisEngineLive({ workersAi: fakeAi });
		expect(mocks.workersAiEngine).toHaveBeenCalledOnce();
	});

	it("selected engines report their provider tag", async () => {
		expect((await extract({ anthropicApiKey: "k" })).engine).toBe("anthropic!fallback");
		expect((await extract({ openAiApiKey: "k" })).engine).toBe("openai!fallback");
		expect(AnamnesisEngineLive({})).toBe(heuristicAnamnesisEngineLive);
	});
});
