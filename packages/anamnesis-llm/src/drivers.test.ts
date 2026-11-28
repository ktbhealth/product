import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnamnesisEngine } from "@ktb/anamnesis/services";
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
	lmPort: vi.fn(),
	waiPort: vi.fn(),
}));

vi.mock("./llm.ts", async () => {
	const Layer = await import("effect/Layer");
	mocks.anthropicLive.mockImplementation(() => Layer.empty);
	mocks.openAiLive.mockImplementation(() => Layer.empty);
	return {
		anthropicLanguageModelLive: mocks.anthropicLive,
		openAiLanguageModelLive: mocks.openAiLive,
	};
});

// The env→LlmPort adapters are unit-tested in llm-port.test.ts; here
// they are stubbed to a failing port so driver wiring is asserted
// without provider transports.
vi.mock("./llm-port.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./llm-port.ts")>();
	const { LlmPort, PortError } = await import("@ktb/eval-core");
	const Effect = await import("effect/Effect");
	const Layer = await import("effect/Layer");
	const failing = () =>
		Layer.succeed(
			LlmPort,
			LlmPort.of({
				generate: () => Effect.fail(new PortError({ port: "llm", message: "provider down" })),
				correct: () => Effect.fail(new PortError({ port: "llm", message: "provider down" })),
			}),
		);
	mocks.lmPort.mockImplementation(failing);
	mocks.waiPort.mockImplementation(failing);
	return {
		...actual,
		makeLanguageModelLlmPort: mocks.lmPort,
		makeWorkersAiLlmPort: mocks.waiPort,
	};
});

const fakeWorkersAi: WorkersAiBinding = { run: async () => ({ response: "{}" }) };

beforeEach(() => {
	mocks.anthropicLive.mockClear();
	mocks.openAiLive.mockClear();
	mocks.lmPort.mockClear();
	mocks.waiPort.mockClear();
});

describe("anamnesis engine drivers", () => {
	it("all provide the AnamnesisEngine port", () => {
		for (const d of [
			anthropicAnamnesisDriver,
			openAiAnamnesisDriver,
			workersAiAnamnesisDriver,
			heuristicAnamnesisDriver,
		])
			expect(d.port).toBe(AnamnesisEngine.key);
	});

	it("anthropic is eligible iff its key is set", () => {
		expect(anthropicAnamnesisDriver.id).toBe("anamnesis-anthropic");
		expect(anthropicAnamnesisDriver.when?.({})).toBe(false);
		expect(anthropicAnamnesisDriver.when?.({ anthropicApiKey: "" })).toBe(false);
		expect(anthropicAnamnesisDriver.when?.({ anthropicApiKey: "k" })).toBe(true);
	});

	it("openai is eligible only when anthropic is absent and a key or base URL is set", () => {
		expect(openAiAnamnesisDriver.id).toBe("anamnesis-openai");
		expect(openAiAnamnesisDriver.when?.({})).toBe(false);
		expect(openAiAnamnesisDriver.when?.({ openAiApiKey: "k" })).toBe(true);
		// Keyless OpenAI-compatible endpoints (local servers, the
		// AI_BASE_URL dev shim) select this driver too.
		expect(openAiAnamnesisDriver.when?.({ openAiBaseUrl: "https://x" })).toBe(true);
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
			workersAiAnamnesisDriver.when?.({ openAiBaseUrl: "https://x", workersAi: fakeWorkersAi }),
		).toBe(false);
		expect(
			workersAiAnamnesisDriver.when?.({ anthropicApiKey: "k", workersAi: fakeWorkersAi }),
		).toBe(false);
	});

	it("heuristic is the fallback when no provider is configured", () => {
		expect(heuristicAnamnesisDriver.id).toBe("anamnesis-heuristic");
		expect(heuristicAnamnesisDriver.when?.({})).toBe(true);
		expect(heuristicAnamnesisDriver.when?.({ openAiApiKey: "k" })).toBe(false);
		expect(heuristicAnamnesisDriver.when?.({ openAiBaseUrl: "https://x" })).toBe(false);
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
		expect(heuristicAnamnesisDriver.provides({})).toBeDefined();
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
		expect(mocks.lmPort).toHaveBeenLastCalledWith("anthropic", "m", expect.anything());
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
			apiKey: undefined,
			baseUrl: undefined,
			model: "gpt-4o-mini",
		});
	});

	it("workers-ai provides forwards the binding and model with the default", () => {
		workersAiAnamnesisDriver.provides({ workersAi: fakeWorkersAi });
		expect(mocks.waiPort).toHaveBeenLastCalledWith(fakeWorkersAi, DEFAULT_WORKERS_AI_MODEL);
		workersAiAnamnesisDriver.provides({ workersAi: fakeWorkersAi, workersAiModel: "m" });
		expect(mocks.waiPort).toHaveBeenLastCalledWith(fakeWorkersAi, "m");
	});

	it("heuristic provides binds no env LlmPort", () => {
		heuristicAnamnesisDriver.provides({});
		expect(mocks.lmPort).not.toHaveBeenCalled();
		expect(mocks.waiPort).not.toHaveBeenCalled();
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
		expect(
			(
				await run(
					asEngineLayer(
						workersAiAnamnesisDriver.provides({
							workersAi: fakeWorkersAi,
							workersAiModel: "m",
						}),
					),
				)
			).engine,
		).toBe("workers-ai:m!fallback");
		expect((await run(asEngineLayer(heuristicAnamnesisDriver.provides({})))).engine).toBe(
			"heuristic",
		);
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
