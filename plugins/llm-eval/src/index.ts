import { definePlugin, type Plugin } from "@ktb/kernel";
import { EvalPort, type Contribution } from "@ktb/eval-core";
import { LlmPort } from "@ktb/eval-consultation/ports";

/**
 * llm.eval — generative + decision capability plugin (P-074 phase 3,
 * P-070).
 *
 * DATA-ONLY registrar, same contract as transcription.tts: declares
 * the eval-core contributions (on the manifest's `contributions`
 * channel) and adapter keys for the two model ports — LlmPort
 * (generative, ACP-delegated: script_gen + cleanup stages) and
 * EvalPort (typed decision/judge). Adapter implementations stay in the
 * exempt-edge packages (@ktb/eval-adapter-stub/-local/-cloud) because
 * plugins/* is inside the arch preset's PORT_GLOBS — the Jev adapter's
 * provider path literal alone would trip arch/provider-lockin
 * here. See plugins/transcription-tts/src/index.ts for the full
 * mechanism.
 *
 * The ACP wire contract (acp.ts) and TaskEnvelope codec are DOMAIN
 * code and stay in the consultation domain pack (evals/consultation)
 * — this plugin only declares which adapters speak it.
 *
 * Adapter keys → packages: "stub" → @ktb/eval-adapter-stub,
 * "acp" → @ktb/ai-adapter-acp `makeAcpLlm`,
 * "jev" → @ktb/eval-adapter-local `makeJevEval`,
 * "systemone" → @ktb/eval-adapter-local `makeSystemOneEval` — the
 * TypeSafe `/v1/systemone` wire shape, served locally by OpenJev
 * ("wev serve"), razorback16/openjev or amithgc/local-jev.
 * "workers-ai" → @ktb/eval-adapter-cloud `makeWorkersAiLlm` /
 * `makeWorkersAiEval` — generative Workers AI chat models; the judge
 * is a generative stand-in (self-reported probabilities, not
 * calibrated — System One stays the gate-grade judge).
 * "acp-cli" → @ktb/ai-adapter-node `makeNodeAcpLlm` — a spawned ACP
 * agent over stdio (Devin CLI `devin acp` by default via
 * EVAL_ACP_AGENT_CMD); selected by the `devin`/`local-devin` eval
 * profiles.
 * "openai-compat" → @ktb/ai-adapter-openai `makeChatLlm` — any
 * OpenAI-compatible chat endpoint (Ollama, LM Studio) via
 * EVAL_LLM_BASE_URL/EVAL_LLM_MODEL; selected by `local-chat`.
 */

/**
 * Declared contributions. `llm` covers LlmPort.generate (stage
 * `script_gen`) and LlmPort.correct (stage `cleanup`, EditList-pinned);
 * `eval` covers EvalPort.judge (stage `judge`). Stage ids match the
 * RunRecord.stage vocabulary the adapters emit.
 */
export const llmEvalContributions: readonly Contribution[] = [
	{
		kind: "eval.capability",
		id: "llm",
		version: "1",
		meta: {
			port: LlmPort.key,
			adapters: {
				stub: "@ktb/eval-adapter-stub",
				noop: "@ktb/eval-adapter-stub",
				acp: "@ktb/ai-adapter-acp",
				"acp-cli": "@ktb/ai-adapter-node",
				"openai-compat": "@ktb/ai-adapter-openai",
				"workers-ai": "@ktb/eval-adapter-cloud",
			},
		},
	},
	{
		kind: "eval.capability",
		id: "eval",
		version: "1",
		meta: {
			port: EvalPort.key,
			adapters: {
				stub: "@ktb/eval-adapter-stub",
				jev: "@ktb/eval-adapter-local",
				systemone: "@ktb/eval-adapter-local",
				"workers-ai": "@ktb/eval-adapter-cloud",
			},
		},
	},
	{
		kind: "eval.stage",
		id: "script_gen",
		version: "1",
		meta: { port: LlmPort.key },
	},
	{
		kind: "eval.stage",
		id: "cleanup",
		version: "1",
		meta: { port: LlmPort.key },
	},
	{
		kind: "eval.stage",
		id: "judge",
		version: "1",
		meta: { port: EvalPort.key },
	},
];

export const llmEvalPlugin = definePlugin({
	id: "llm.eval",
	meta: { keywords: ["eval", "llm", "services"] },
	contributions: llmEvalContributions,
});

export const plugins: readonly Plugin[] = [llmEvalPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"llm.eval": true;
	}
}
