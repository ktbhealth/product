import type { LlmConfig } from "@ktb/anamnesis-llm/services";

/**
 * llm-config.ts — env → {@link LlmConfig} resolution, extracted from
 * createApp so the provider-precedence rules are unit-testable.
 *
 * AI_BASE_URL (the apps/web dev shim's OpenAI-compatible server,
 * lib/ai.ts) feeds the KEYLESS OpenAI env endpoint — generative calls
 * then flow through the canonical LlmPort env route (effect/ai →
 * LlmPort) instead of the binding's chat-completions branch. It only
 * applies when no explicit LLM_BASE_URL or provider key exists: an
 * OPENAI_API_KEY/LLM_API_KEY still wins api.openai.com, and
 * LLM_BASE_URL always wins outright — exactly the precedence the
 * shim's chat path had when it was the workers-ai fallback.
 */
export interface LlmEnv {
	readonly ANTHROPIC_API_KEY?: string;
	readonly LLM_API_KEY?: string;
	readonly OPENAI_API_KEY?: string;
	readonly LLM_BASE_URL?: string;
	readonly AI_BASE_URL?: string;
	readonly LLM_MODEL?: string;
	readonly WORKERS_AI_MODEL?: string;
	readonly AI?: LlmConfig["workersAi"];
}

export const resolveLlmConfig = (env: LlmEnv): LlmConfig => {
	const openAiApiKey = env.LLM_API_KEY ?? env.OPENAI_API_KEY;
	return {
		anthropicApiKey: env.ANTHROPIC_API_KEY,
		openAiApiKey,
		openAiBaseUrl: env.LLM_BASE_URL ?? (openAiApiKey ? undefined : env.AI_BASE_URL),
		openAiModel: env.LLM_MODEL,
		workersAi: env.AI,
		workersAiModel: env.WORKERS_AI_MODEL,
	};
};
