import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import { LanguageModel } from "effect/ai";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";

/**
 * Injected LLM configuration — resolved once by the composition root from
 * platform env/secrets. Provider packages never read process.env.
 */
export interface LlmConfig {
	readonly anthropicApiKey?: string;
	readonly anthropicModel?: string;
	readonly openAiApiKey?: string;
	readonly openAiBaseUrl?: string;
	readonly openAiModel?: string;
	readonly workersAi?: import("./workers-ai.ts").WorkersAiBinding;
	readonly workersAiModel?: string;
}

const http = FetchHttpClient.layer;

/** OpenAI-compatible servers are addressed at `<base>/v1` — accept
 * the base with or without the suffix (the AI_BASE_URL/LLM_BASE_URL
 * convention allows both) and normalize once here. */
const openAiCompatBaseUrl = (baseUrl: string): string => {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

/** Self-contained OpenAI LanguageModel layer (client + fetch transport).
 * `apiKey` is optional — local OpenAI-compatible servers (llama.cpp,
 * LM Studio, the AI_BASE_URL dev shim) speak the same wire without
 * bearer auth; the client only sends the header when a key exists. */
export const openAiLanguageModelLive = (options: {
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly model: string;
}): Layer.Layer<LanguageModel.LanguageModel> =>
	OpenAiLanguageModel.layer({ model: options.model }).pipe(
		Layer.provide(
			OpenAiClient.layer({
				...(options.apiKey !== undefined && options.apiKey !== ""
					? { apiKey: Redacted.make(options.apiKey) }
					: {}),
				...(options.baseUrl !== undefined ? { apiUrl: openAiCompatBaseUrl(options.baseUrl) } : {}),
			}).pipe(Layer.provide(http)),
		),
	);

/** Self-contained Anthropic LanguageModel layer (client + fetch transport). */
export const anthropicLanguageModelLive = (options: {
	readonly apiKey: string;
	readonly model: string;
}): Layer.Layer<LanguageModel.LanguageModel> =>
	AnthropicLanguageModel.layer({ model: options.model }).pipe(
		Layer.provide(
			AnthropicClient.layer({
				apiKey: Redacted.make(options.apiKey),
			}).pipe(Layer.provide(http)),
		),
	);
