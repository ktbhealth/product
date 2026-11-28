import { describe, expect, it } from "vitest";

import { resolveLlmConfig } from "./llm-config.ts";

const ai = { run: async () => ({}) };

describe("resolveLlmConfig", () => {
	it("passes provider keys and models through", () => {
		expect(
			resolveLlmConfig({
				ANTHROPIC_API_KEY: "a",
				LLM_API_KEY: "l",
				OPENAI_API_KEY: "o",
				LLM_BASE_URL: "https://llm",
				LLM_MODEL: "m",
				WORKERS_AI_MODEL: "w",
				AI: ai,
			}),
		).toEqual({
			anthropicApiKey: "a",
			openAiApiKey: "l",
			openAiBaseUrl: "https://llm",
			openAiModel: "m",
			workersAi: ai,
			workersAiModel: "w",
		});
	});

	it("falls back to OPENAI_API_KEY when LLM_API_KEY is absent", () => {
		expect(resolveLlmConfig({ OPENAI_API_KEY: "o" }).openAiApiKey).toBe("o");
	});

	it("maps AI_BASE_URL onto the keyless OpenAI endpoint", () => {
		expect(resolveLlmConfig({ AI_BASE_URL: "http://local:8080/v1" })).toEqual({
			anthropicApiKey: undefined,
			openAiApiKey: undefined,
			openAiBaseUrl: "http://local:8080/v1",
			openAiModel: undefined,
			workersAi: undefined,
			workersAiModel: undefined,
		});
	});

	it("LLM_BASE_URL always wins over AI_BASE_URL", () => {
		expect(
			resolveLlmConfig({ LLM_BASE_URL: "https://llm", AI_BASE_URL: "http://local" }).openAiBaseUrl,
		).toBe("https://llm");
	});

	it("a provider key keeps api.openai.com — AI_BASE_URL does not hijack keyed chat", () => {
		expect(
			resolveLlmConfig({ OPENAI_API_KEY: "o", AI_BASE_URL: "http://local" }).openAiBaseUrl,
		).toBeUndefined();
		expect(
			resolveLlmConfig({ LLM_API_KEY: "l", AI_BASE_URL: "http://local" }).openAiBaseUrl,
		).toBeUndefined();
	});

	it("returns undefined fields for an empty env", () => {
		expect(resolveLlmConfig({})).toEqual({
			anthropicApiKey: undefined,
			openAiApiKey: undefined,
			openAiBaseUrl: undefined,
			openAiModel: undefined,
			workersAi: undefined,
			workersAiModel: undefined,
		});
	});
});
