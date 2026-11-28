import type { Driver } from "@ktb/driver-framework";

import { AnamnesisEngine } from "@ktb/anamnesis/services";
import { anthropicLanguageModelLive, openAiLanguageModelLive, type LlmConfig } from "./llm.ts";
import { makeLanguageModelLlmPort, makeWorkersAiLlmPort } from "./llm-port.ts";
import { anamnesisEngineFor } from "./services.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "./workers-ai.ts";

/**
 * Driver descriptors for the AnamnesisEngine port.
 * `when` predicates mirror the branch conditions of AnamnesisEngineLive
 * exactly — provider precedence (anthropic > openai > workers-ai >
 * heuristic) is preserved, and each predicate is order-independent.
 *
 * Every LLM driver binds the engine over an env-derived LlmPort layer
 * routed through `preferringLlmPortLive` — the ai-provider plugin's
 * platform-default endpoint wins per call, the env provider is the
 * fallback. The heuristic driver binds the same wrapper with NO env
 * port: platform-or-nothing, degrading to the heuristic extractor.
 */

export const anthropicAnamnesisDriver: Driver<LlmConfig> = {
	id: "anamnesis-anthropic",
	port: AnamnesisEngine.key,
	when: (cfg) => Boolean(cfg.anthropicApiKey),
	provides: (cfg) => {
		const model = cfg.anthropicModel ?? "claude-haiku-4-5";
		return anamnesisEngineFor(
			"anthropic",
			makeLanguageModelLlmPort(
				"anthropic",
				model,
				anthropicLanguageModelLive({ apiKey: cfg.anthropicApiKey ?? "", model }),
			),
		);
	},
};

export const openAiAnamnesisDriver: Driver<LlmConfig> = {
	id: "anamnesis-openai",
	port: AnamnesisEngine.key,
	// OpenAI-compatible endpoints need no key — a bare baseUrl (local
	// servers, the AI_BASE_URL dev shim) selects this driver too.
	when: (cfg) => !cfg.anthropicApiKey && Boolean(cfg.openAiApiKey || cfg.openAiBaseUrl),
	provides: (cfg) => {
		const model = cfg.openAiModel ?? "gpt-4o-mini";
		return anamnesisEngineFor(
			"openai",
			makeLanguageModelLlmPort(
				"openai",
				model,
				openAiLanguageModelLive({
					apiKey: cfg.openAiApiKey,
					baseUrl: cfg.openAiBaseUrl,
					model,
				}),
			),
		);
	},
};

export const workersAiAnamnesisDriver: Driver<LlmConfig> = {
	id: "anamnesis-workers-ai",
	port: AnamnesisEngine.key,
	when: (cfg) =>
		!cfg.anthropicApiKey && !cfg.openAiApiKey && !cfg.openAiBaseUrl && Boolean(cfg.workersAi),
	provides: (cfg) => {
		const model = cfg.workersAiModel ?? DEFAULT_WORKERS_AI_MODEL;
		return anamnesisEngineFor(
			`workers-ai:${model}`,
			makeWorkersAiLlmPort(cfg.workersAi as NonNullable<LlmConfig["workersAi"]>, model),
		);
	},
};

export const heuristicAnamnesisDriver: Driver<LlmConfig> = {
	id: "anamnesis-heuristic",
	port: AnamnesisEngine.key,
	when: (cfg) => !cfg.anthropicApiKey && !cfg.openAiApiKey && !cfg.openAiBaseUrl && !cfg.workersAi,
	// No env port — the platform default (when the ai-provider plugin
	// binds one) is the only generative path; otherwise every extract
	// degrades to the heuristic extractor with the plain "heuristic"
	// tag.
	provides: () => anamnesisEngineFor("heuristic"),
};

/** All LLM engine drivers, grouped by port in precedence order. */
export const llmDrivers: Driver<LlmConfig>[] = [
	anthropicAnamnesisDriver,
	openAiAnamnesisDriver,
	workersAiAnamnesisDriver,
	heuristicAnamnesisDriver,
];
