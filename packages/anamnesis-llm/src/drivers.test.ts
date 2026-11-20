import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { heuristicAnamnesisEngineLive } from "./services.ts";
import {
	anthropicAnamnesisDriver,
	heuristicAnamnesisDriver,
	llmDrivers,
	openAiAnamnesisDriver,
	workersAiAnamnesisDriver,
} from "./drivers.ts";
import { DEFAULT_WORKERS_AI_MODEL, type WorkersAiBinding } from "./workers-ai.ts";

const mocks = vi.hoisted(() => ({
	anthropicLive: vi.fn(),
	openAiLive: vi.fn(),
	workersAiEngine: vi.fn(),
}));

vi.mock("./llm.ts", async () => {
	const { LanguageModel } = await import("effect/ai");
	const Effect = await import("effect/Effect");
	const Layer = await import("effect/Layer");
	const failingModel = {
		[LanguageModel.TypeId]: LanguageModel.TypeId,
		generateText: () => Effect.die("unused"),
		generateObject: () => Effect.fail(new Error("provider down")),
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

vi.mock("./workers-ai.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./workers-ai.ts")>();
	const Layer = await import("effect/Layer");
	mocks.workersAiEngine.mockReturnValue(Layer.empty);
	return { ...actual, makeWorkersAiAnamnesisEngine: mocks.workersAiEngine };
});

const fakeWorkersAi: WorkersAiBinding = { run: async () => ({ response: "{}" }) };

beforeEach(() => {
	mocks.anthropicLive.mockClear();
	mocks.openAiLive.mockClear();
	mocks.workersAiEngine.mockClear();
});

describe("anamnesis engine drivers", () => {
	it("all provide the AnamnesisEngine port", () => {
		for (const d of [anthropicAnamnesisDriver, openAiAnamnesisDriver, heuristicAnamnesisDriver])
			expect(d.port).toBe(AnamnesisEngine.key);
	});

	it("anthropic is eligible iff its key is set", () => {
		expect(anthropicAnamnesisDriver.id).toBe("anamnesis-anthropic");
		expect(anthropicAnamnesisDriver.when?.({})).toBe(false);
		expect(anthropicAnamnesisDriver.when?.({ anthropicApiKey: "" })).toBe(false);
		expect(anthropicAnamnesisDriver.when?.({ anthropicApiKey: "k" })).toBe(true);
	});

	it("openai is eligible only when anthropic is absent and its key is set", () => {
		expect(openAiAnamnesisDriver.id).toBe("anamnesis-openai");
		expect(openAiAnamnesisDriver.when?.({})).toBe(false);
		expect(openAiAnamnesisDriver.when?.({ openAiApiKey: "k" })).toBe(true);
		expect(openAiAnamnesisDriver.when?.({ anthropicApiKey: "k", openAiApiKey: "k" })).toBe(false);
		expect(openAiAnamnesisDriver.when?.({ anthropicApiKey: "k" })).toBe(false);
	});

	it("workers-ai is eligible only when cloud keys are absent and the binding exists", () => {
		expect(workersAiAnamnesisDriver.id).toBe("anamnesis-workers-ai");
		expect(workersAiAnamnesisDriver.when?.({})).toBe(false);
		expect(workersAiAnamnesisDriver.when?.({ workersAi: fakeWorkersAi })).toBe(true);
		expect(workersAiAnamnesisDriver.when?.({ openAiApiKey: "k", workersAi: fakeWorkersAi })).toBe(
			false,
		);
		expect(
			workersAiAnamnesisDriver.when?.({ anthropicApiKey: "k", workersAi: fakeWorkersAi }),
		).toBe(false);
	});

	it("heuristic is the fallback when no provider is configured", () => {
		expect(heuristicAnamnesisDriver.id).toBe("anamnesis-heuristic");
		expect(heuristicAnamnesisDriver.when?.({})).toBe(true);
		expect(heuristicAnamnesisDriver.when?.({ openAiApiKey: "k" })).toBe(false);
		expect(heuristicAnamnesisDriver.when?.({ anthropicApiKey: "k" })).toBe(false);
		expect(heuristicAnamnesisDriver.when?.({ anthropicApiKey: "k", openAiApiKey: "k" })).toBe(
			false,
		);
		expect(heuristicAnamnesisDriver.when?.({ workersAi: fakeWorkersAi })).toBe(false);
	});

	it("provides build layers for every config shape", () => {
		expect(anthropicAnamnesisDriver.provides({})).toBeDefined();
		expect(
			anthropicAnamnesisDriver.provides({ anthropicApiKey: "k", anthropicModel: "m" }),
		).toBeDefined();
		expect(openAiAnamnesisDriver.provides({})).toBeDefined();
		expect(
			openAiAnamnesisDriver.provides({
				openAiApiKey: "k",
				openAiBaseUrl: "https://x",
				openAiModel: "m",
			}),
		).toBeDefined();
		expect(heuristicAnamnesisDriver.provides({})).toBe(heuristicAnamnesisEngineLive);
		expect(workersAiAnamnesisDriver.provides({ workersAi: fakeWorkersAi })).toBeDefined();
		expect(
			workersAiAnamnesisDriver.provides({
				workersAi: fakeWorkersAi,
				workersAiModel: "m",
			}),
		).toBeDefined();
	});

	it("anthropic provides forwards key and model with documented defaults", () => {
		anthropicAnamnesisDriver.provides({ anthropicApiKey: "k", anthropicModel: "m" });
		expect(mocks.anthropicLive).toHaveBeenLastCalledWith({ apiKey: "k", model: "m" });
		anthropicAnamnesisDriver.provides({});
		expect(mocks.anthropicLive).toHaveBeenLastCalledWith({
			apiKey: "",
			model: "claude-haiku-4-5",
		});
	});

	it("openai provides forwards key, base URL and model with documented defaults", () => {
		openAiAnamnesisDriver.provides({
			openAiApiKey: "k",
			openAiBaseUrl: "https://x",
			openAiModel: "m",
		});
		expect(mocks.openAiLive).toHaveBeenLastCalledWith({
			apiKey: "k",
			baseUrl: "https://x",
			model: "m",
		});
		openAiAnamnesisDriver.provides({});
		expect(mocks.openAiLive).toHaveBeenLastCalledWith({
			apiKey: "",
			baseUrl: undefined,
			model: "gpt-4o-mini",
		});
	});

	it("workers-ai provides forwards the binding and model with the default", () => {
		workersAiAnamnesisDriver.provides({ workersAi: fakeWorkersAi });
		expect(mocks.workersAiEngine).toHaveBeenLastCalledWith(fakeWorkersAi, DEFAULT_WORKERS_AI_MODEL);
		workersAiAnamnesisDriver.provides({ workersAi: fakeWorkersAi, workersAiModel: "m" });
		expect(mocks.workersAiEngine).toHaveBeenLastCalledWith(fakeWorkersAi, "m");
	});

	it("provided engines report their provider tag", async () => {
		const run = async (layer: Layer.Layer<AnamnesisEngine>) => {
			const engine = await Effect.runPromise(
				Effect.gen(function* () {
					return yield* AnamnesisEngine;
				}).pipe(Effect.provide(layer)),
			);
			return Effect.runPromise(engine.extract({ transcript: "t" }));
		};
		const asEngineLayer = (layer: unknown) => layer as Layer.Layer<AnamnesisEngine>;
		expect(
			(await run(asEngineLayer(anthropicAnamnesisDriver.provides({ anthropicApiKey: "k" }))))
				.engine,
		).toBe("anthropic!fallback");
		expect(
			(await run(asEngineLayer(openAiAnamnesisDriver.provides({ openAiApiKey: "k" })))).engine,
		).toBe("openai!fallback");
	});
});

describe("llmDrivers", () => {
	it("lists all four engine drivers", () => {
		expect(llmDrivers).toHaveLength(4);
		expect(llmDrivers.map((d) => d.id)).toEqual([
			"anamnesis-anthropic",
			"anamnesis-openai",
			"anamnesis-workers-ai",
			"anamnesis-heuristic",
		]);
	});
});
