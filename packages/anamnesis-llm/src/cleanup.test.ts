import { LanguageModel } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	anthropicLive: vi.fn(),
	openAiLive: vi.fn(),
}));

vi.mock("./llm.ts", async () => {
	const { LanguageModel } = await import("effect/ai");
	const Layer = await import("effect/Layer");
	const Effect = await import("effect/Effect");
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

import { CLEANUP_SYSTEM_PROMPT, correctTranscript } from "./cleanup.ts";
import { DEFAULT_WORKERS_AI_MODEL, type WorkersAiBinding } from "./workers-ai.ts";

const run = (cfg: Parameters<typeof correctTranscript>[0], transcript: string) =>
	Effect.runPromise(correctTranscript(cfg, transcript));

const ok = (text: string) => Effect.succeed({ text });
const fakeAi = (impl: WorkersAiBinding["run"]) => ({ run: vi.fn(impl) });

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

beforeEach(() => {
	mocks.generateText.mockReset();
	mocks.anthropicLive.mockClear();
	mocks.openAiLive.mockClear();
});

describe("CLEANUP_SYSTEM_PROMPT", () => {
	it("carries the surface-correction contract", () => {
		expect(CLEANUP_SYSTEM_PROMPT).toContain("PT-BR");
		expect(CLEANUP_SYSTEM_PROMPT).toContain("Never summarize");
		expect(CLEANUP_SYSTEM_PROMPT).toContain("verbatim");
	});
});

describe("correctTranscript", () => {
	it("returns null without calling a provider for an empty transcript", async () => {
		const ai = fakeAi(async () => "x");
		await expect(run({ anthropicApiKey: "k", workersAi: ai }, "  \n ")).resolves.toBeNull();
		expect(mocks.anthropicLive).not.toHaveBeenCalled();
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("returns null without logging when no provider is configured", async () => {
		const { entries, logger } = captureLogs();
		await expect(
			Effect.runPromise(correctTranscript({}, "olá").pipe(Effect.provide(Logger.layer([logger])))),
		).resolves.toBeNull();
		expect(entries).toHaveLength(0);
	});

	describe("anthropic", () => {
		it("corrects with the default model and the cleanup prompt", async () => {
			mocks.generateText.mockReturnValue(ok("  Olá, doutor.  "));
			await expect(run({ anthropicApiKey: "ak" }, "  ola doutor  ")).resolves.toEqual({
				corrected: "Olá, doutor.",
				engine: "anthropic",
			});
			expect(mocks.anthropicLive).toHaveBeenCalledWith({
				apiKey: "ak",
				model: "claude-haiku-4-5",
			});
			// TaskEnvelope is text-in/text-out: the cleanup contract is
			// inlined into a single user message ahead of the transcript.
			const { prompt } = mocks.generateText.mock.calls[0]![0] as { prompt: unknown };
			const sent = JSON.stringify(prompt);
			expect(sent).toContain("transcription post-processor for Brazilian Portuguese");
			expect(sent).toContain("ola doutor");
		});

		it("honours a configured model", async () => {
			mocks.generateText.mockReturnValue(ok("ok"));
			await run({ anthropicApiKey: "ak", anthropicModel: "claude-x" }, "texto");
			expect(mocks.anthropicLive).toHaveBeenCalledWith({ apiKey: "ak", model: "claude-x" });
		});

		it("returns null when the model answers with only whitespace", async () => {
			mocks.generateText.mockReturnValue(ok("   "));
			await expect(run({ anthropicApiKey: "ak" }, "texto")).resolves.toBeNull();
		});

		it("never fails: provider errors become null", async () => {
			mocks.generateText.mockReturnValue(Effect.fail(new Error("provider down")));
			const { entries, logger } = captureLogs();
			const { spans, tracer } = makeTracer();
			await expect(
				Effect.runPromise(
					correctTranscript({ anthropicApiKey: "ak" }, "texto").pipe(
						Effect.provideService(Tracer.Tracer, tracer),
						Effect.provide(Logger.layer([logger])),
					),
				),
			).resolves.toBeNull();
			const span = spans.find((s) => s.name === "transcript.cleanup");
			expect(span?.attributes.get("transcript.engine")).toBe("anthropic");
			const warn = entries.find((e) => String(e.message).includes("transcript cleanup failed"));
			expect(warn?.annotations.engine).toBe("anthropic");
			expect(String(warn?.annotations.error)).toContain("provider down");
		});

		it("never fails: provider defects become null", async () => {
			mocks.generateText.mockReturnValue(Effect.die(new Error("defect boom")));
			const { entries, logger } = captureLogs();
			await expect(
				Effect.runPromise(
					correctTranscript({ anthropicApiKey: "ak" }, "texto").pipe(
						Effect.provide(Logger.layer([logger])),
					),
				),
			).resolves.toBeNull();
			const warn = entries.find((e) => String(e.message).includes("transcript cleanup failed"));
			expect(warn?.annotations.engine).toBe("anthropic");
			expect(String(warn?.annotations.error)).toContain("defect boom");
		});
	});

	describe("openai", () => {
		it("corrects with the default model", async () => {
			mocks.generateText.mockReturnValue(ok("Corrigido"));
			await expect(run({ openAiApiKey: "ok" }, "texto")).resolves.toEqual({
				corrected: "Corrigido",
				engine: "openai",
			});
			expect(mocks.openAiLive).toHaveBeenCalledWith({
				apiKey: "ok",
				baseUrl: undefined,
				model: "gpt-4o-mini",
			});
		});

		it("forwards base URL and model", async () => {
			mocks.generateText.mockReturnValue(ok("Corrigido"));
			await run(
				{ openAiApiKey: "ok", openAiBaseUrl: "http://llm.local/v1", openAiModel: "gpt-x" },
				"texto",
			);
			expect(mocks.openAiLive).toHaveBeenCalledWith({
				apiKey: "ok",
				baseUrl: "http://llm.local/v1",
				model: "gpt-x",
			});
		});
	});

	it("prefers anthropic over openai over workers-ai", async () => {
		mocks.generateText.mockReturnValue(ok("x"));
		const ai = fakeAi(async () => "x");
		await run({ anthropicApiKey: "a", openAiApiKey: "o", workersAi: ai }, "t");
		expect(mocks.anthropicLive).toHaveBeenCalledOnce();
		expect(mocks.openAiLive).not.toHaveBeenCalled();
		await run({ openAiApiKey: "o", workersAi: ai }, "t");
		expect(mocks.openAiLive).toHaveBeenCalledOnce();
		expect(ai.run).not.toHaveBeenCalled();
	});

	describe("workers-ai", () => {
		it("corrects with the default model", async () => {
			const ai = fakeAi(async () => ({ response: " Texto limpo. " }));
			await expect(run({ workersAi: ai }, "texto")).resolves.toEqual({
				corrected: "Texto limpo.",
				engine: `workers-ai:${DEFAULT_WORKERS_AI_MODEL}`,
			});
			expect(ai.run).toHaveBeenCalledWith(
				DEFAULT_WORKERS_AI_MODEL,
				expect.objectContaining({
					messages: [
						{
							role: "user",
							content: expect.stringContaining("texto"),
						},
					],
				}),
			);
			const sent = JSON.stringify(ai.run.mock.calls[0]![1]);
			expect(sent).toContain("transcription post-processor for Brazilian Portuguese");
		});

		it("honours a configured model", async () => {
			const ai = fakeAi(async () => "ok");
			await expect(run({ workersAi: ai, workersAiModel: "@cf/m" }, "texto")).resolves.toEqual({
				corrected: "ok",
				engine: "workers-ai:@cf/m",
			});
		});

		it("returns null when the model answers with only whitespace", async () => {
			const ai = fakeAi(async () => ({ response: "  " }));
			await expect(run({ workersAi: ai }, "texto")).resolves.toBeNull();
		});

		it("never fails: binding errors and unknown shapes become null", async () => {
			const { entries, logger } = captureLogs();
			await expect(
				Effect.runPromise(
					correctTranscript(
						{ workersAi: fakeAi(async () => Promise.reject(new Error("boom"))) },
						"texto",
					).pipe(Effect.provide(Logger.layer([logger]))),
				),
			).resolves.toBeNull();
			await expect(
				run({ workersAi: fakeAi(async () => ({ nope: 1 })) }, "texto"),
			).resolves.toBeNull();
			const warn = entries.find((e) => String(e.message).includes("transcript cleanup failed"));
			expect(warn?.annotations.engine).toBe(`workers-ai:${DEFAULT_WORKERS_AI_MODEL}`);
			expect(String(warn?.annotations.error)).toContain("boom");
		});
	});
});
