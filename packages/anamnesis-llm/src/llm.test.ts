import * as Redacted from "effect/Redacted";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	openAiClientLayer: vi.fn(),
	openAiModelLayer: vi.fn(),
	anthropicClientLayer: vi.fn(),
	anthropicModelLayer: vi.fn(),
}));

vi.mock("@effect/ai-openai/OpenAiClient", async () => {
	const Layer = await import("effect/Layer");
	mocks.openAiClientLayer.mockReturnValue(Layer.empty);
	return { layer: mocks.openAiClientLayer };
});

vi.mock("@effect/ai-openai/OpenAiLanguageModel", async () => {
	const Layer = await import("effect/Layer");
	mocks.openAiModelLayer.mockReturnValue(Layer.empty);
	return { layer: mocks.openAiModelLayer };
});

vi.mock("@effect/ai-anthropic/AnthropicClient", async () => {
	const Layer = await import("effect/Layer");
	mocks.anthropicClientLayer.mockReturnValue(Layer.empty);
	return { layer: mocks.anthropicClientLayer };
});

vi.mock("@effect/ai-anthropic/AnthropicLanguageModel", async () => {
	const Layer = await import("effect/Layer");
	mocks.anthropicModelLayer.mockReturnValue(Layer.empty);
	return { layer: mocks.anthropicModelLayer };
});

import { anthropicLanguageModelLive, openAiLanguageModelLive } from "./llm.ts";

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockClear();
});

describe("openAiLanguageModelLive", () => {
	it("returns a layer and wires model, key and base URL into the provider clients", () => {
		const layer = openAiLanguageModelLive({
			apiKey: "sk-test",
			baseUrl: "http://llm.local/v1",
			model: "gpt-x",
		});
		expect(layer).toBeDefined();
		expect(mocks.openAiModelLayer).toHaveBeenCalledWith({ model: "gpt-x" });
		const clientOptions = mocks.openAiClientLayer.mock.calls[0]![0] as {
			apiKey: Redacted.Redacted<string>;
			apiUrl?: string;
		};
		expect(Redacted.value(clientOptions.apiKey)).toBe("sk-test");
		expect(clientOptions.apiUrl).toBe("http://llm.local/v1");
	});

	it("omits apiUrl when no base URL is configured", () => {
		openAiLanguageModelLive({ apiKey: "k", model: "m" });
		const clientOptions = mocks.openAiClientLayer.mock.calls[0]![0] as Record<string, unknown>;
		expect(clientOptions).not.toHaveProperty("apiUrl");
	});
});

describe("anthropicLanguageModelLive", () => {
	it("returns a layer and wires model and key into the provider clients", () => {
		const layer = anthropicLanguageModelLive({ apiKey: "ak", model: "claude-x" });
		expect(layer).toBeDefined();
		expect(mocks.anthropicModelLayer).toHaveBeenCalledWith({ model: "claude-x" });
		const clientOptions = mocks.anthropicClientLayer.mock.calls[0]![0] as {
			apiKey: Redacted.Redacted<string>;
		};
		expect(Redacted.value(clientOptions.apiKey)).toBe("ak");
	});
});
