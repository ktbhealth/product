import { LanguageModel } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LlmPort, PortError, type TaskEnvelope } from "@ktb/eval-core";

import { envLlmPort, makeLanguageModelLlmPort, makeWorkersAiLlmPort } from "./llm-port.ts";
import { DEFAULT_WORKERS_AI_MODEL, type WorkersAiBinding } from "./workers-ai.ts";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	anthropicLive: vi.fn(),
	openAiLive: vi.fn(),
}));

vi.mock("./llm.ts", async () => {
	const Layer = await import("effect/Layer");
	const layerFor = () =>
		Layer.succeed(LanguageModel.LanguageModel, {
			[LanguageModel.TypeId]: LanguageModel.TypeId,
			generateText: mocks.generateText,
			generateObject: () => Effect.die("unused"),
			streamText: () => {
				throw new Error("unused");
			},
		} as unknown as LanguageModel.LanguageModel);
	mocks.anthropicLive.mockImplementation(layerFor);
	mocks.openAiLive.mockImplementation(layerFor);
	return {
		anthropicLanguageModelLive: mocks.anthropicLive,
		openAiLanguageModelLive: mocks.openAiLive,
	};
});

const ENVELOPE: TaskEnvelope = {
	taskId: "t1",
	role: "generator",
	input: "prompt text",
	outputSchema: "Text",
	seed: 7,
};

const runGenerate = (layer: Layer.Layer<LlmPort>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const llm = yield* LlmPort;
			return yield* llm.generate(ENVELOPE);
		}).pipe(Effect.provide(layer)),
	);

const lmLayer = () =>
	Layer.succeed(LanguageModel.LanguageModel, {
		[LanguageModel.TypeId]: LanguageModel.TypeId,
		generateText: mocks.generateText,
		generateObject: () => Effect.die("unused"),
		streamText: () => {
			throw new Error("unused");
		},
	} as unknown as LanguageModel.LanguageModel);

beforeEach(() => {
	mocks.generateText.mockReset();
	mocks.anthropicLive.mockClear();
	mocks.openAiLive.mockClear();
});

describe("makeLanguageModelLlmPort", () => {
	it("generates text and reports the engine tag", async () => {
		mocks.generateText.mockReturnValue(Effect.succeed({ text: "  answer  " }));
		const res = await runGenerate(makeLanguageModelLlmPort("anthropic", "claude-x", lmLayer()));
		expect(res.text).toBe("  answer  ");
		expect(res.record.engine).toBe("anthropic");
		expect(res.record.model).toBe("claude-x");
		expect(res.record.taskId).toBe("t1");
		expect(res.record.seed).toBe(7);
		const call = mocks.generateText.mock.calls[0]![0] as { prompt: unknown };
		expect(JSON.stringify(call.prompt)).toContain("prompt text");
	});

	it("maps provider failures to PortError", async () => {
		mocks.generateText.mockReturnValue(Effect.fail(new Error("provider down")));
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const llm = yield* LlmPort;
				return yield* llm.generate(ENVELOPE);
			}).pipe(Effect.provide(makeLanguageModelLlmPort("openai", "m", lmLayer()))),
		);
		expect(exit._tag).toBe("Failure");
	});

	it("stringifies non-Error provider failures into the PortError message", async () => {
		mocks.generateText.mockReturnValue(Effect.fail("rate limited"));
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				const llm = yield* LlmPort;
				return yield* llm.generate(ENVELOPE);
			}).pipe(Effect.provide(makeLanguageModelLlmPort("openai", "m", lmLayer())), Effect.flip),
		);
		expect(error).toBeInstanceOf(PortError);
		expect(error.message).toBe("openai: rate limited");
	});

	it("omits the record model when none is configured", async () => {
		mocks.generateText.mockReturnValue(Effect.succeed({ text: "ok" }));
		const res = await runGenerate(makeLanguageModelLlmPort("openai", undefined, lmLayer()));
		expect(res.record.engine).toBe("openai");
		expect(res.record.model).toBeUndefined();
	});

	it("correct() fails honestly — env providers have no corrector", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const llm = yield* LlmPort;
				return yield* llm.correct({ ...ENVELOPE, role: "corrector", outputSchema: "EditList" });
			}).pipe(Effect.provide(makeLanguageModelLlmPort("openai", "m", lmLayer()))),
		);
		expect(exit._tag).toBe("Failure");
	});
});

describe("makeWorkersAiLlmPort", () => {
	const fakeAi = (run: WorkersAiBinding["run"]): WorkersAiBinding => ({ run });

	it("generates through the binding and tags workers-ai:<model>", async () => {
		const run = vi.fn(async () => ({ response: "clean text" }));
		const res = await runGenerate(makeWorkersAiLlmPort(fakeAi(run), "@cf/m"));
		expect(res.text).toBe("clean text");
		expect(res.record.engine).toBe("workers-ai:@cf/m");
		expect(run).toHaveBeenCalledWith(
			"@cf/m",
			expect.objectContaining({
				messages: [{ role: "user", content: "prompt text" }],
			}),
		);
	});

	it("maps binding failures to PortError", async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const llm = yield* LlmPort;
				return yield* llm.generate(ENVELOPE);
			}).pipe(
				Effect.provide(
					makeWorkersAiLlmPort(
						fakeAi(async () => {
							throw new Error("ai down");
						}),
						"m",
					),
				),
			),
		);
		expect(exit._tag).toBe("Failure");
	});
});

describe("envLlmPort", () => {
	it("returns null when no provider is configured", () => {
		expect(envLlmPort({})).toBeNull();
	});

	it("selects anthropic > openai > workers-ai with documented defaults", () => {
		expect(envLlmPort({ anthropicApiKey: "a" })?.engine).toBe("anthropic");
		expect(mocks.anthropicLive).toHaveBeenLastCalledWith({
			apiKey: "a",
			model: "claude-haiku-4-5",
		});
		expect(envLlmPort({ openAiApiKey: "o" })?.engine).toBe("openai");
		expect(mocks.openAiLive).toHaveBeenLastCalledWith({
			apiKey: "o",
			baseUrl: undefined,
			model: "gpt-4o-mini",
		});
		// Keyless OpenAI-compatible endpoint (local server / AI_BASE_URL).
		expect(envLlmPort({ openAiBaseUrl: "http://local" })?.engine).toBe("openai");
		expect(mocks.openAiLive).toHaveBeenLastCalledWith({
			apiKey: undefined,
			baseUrl: "http://local",
			model: "gpt-4o-mini",
		});
		const ai = { run: async () => ({}) };
		expect(envLlmPort({ workersAi: ai })?.engine).toBe(`workers-ai:${DEFAULT_WORKERS_AI_MODEL}`);
		// Precedence: first configured provider wins.
		expect(envLlmPort({ anthropicApiKey: "a", openAiApiKey: "o", workersAi: ai })?.engine).toBe(
			"anthropic",
		);
		expect(envLlmPort({ openAiApiKey: "o", workersAi: ai })?.engine).toBe("openai");
	});
});
