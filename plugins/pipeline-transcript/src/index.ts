import { definePlugin, type Plugin } from "@ktb/kernel";

import { transcriptOrchestrationPack } from "./orchestration.ts";
import { transcriptPipelinePack } from "./pack.ts";

// The pack contract (constants, wire/state types, stage impls,
// transcriptPipelinePack) lives in ./pack.ts — a leaf module both this
// manifest and ./orchestration.ts import, so contributing the
// orchestration pack here cannot create an import cycle. Re-exported
// so "./index.ts" stays the package's public surface.
export * from "./pack.ts";

/**
 * pipeline.transcript — the `consultation-transcript` pipeline pack
 * and its OrchestrationDef twin.
 *
 * Contributes BOTH engines during the P-120 cutover: the
 * `transcriptPipelinePack` on `pipelines` (PipelineRegistry) and the
 * parity `transcriptOrchestrationPack` on `orchestrations`
 * (OrchestratorRegistry) — the orchestration kinds invoke the SAME
 * stage impls, so state/event parity is by construction (see
 * ./orchestration.ts). Production surfaces prefer the orchestrator
 * and fall back to the pipeline while the cutover settles.
 */
export const transcriptPipelinePlugin = definePlugin({
	id: "pipeline.transcript",
	meta: {
		name: "Transcript pipeline",
		description:
			"Consultation transcript cleanup pipeline — ASR-error gating plus platform-endpoint LLM correction, shared by production surfaces and eval drivers.",
		keywords: ["transcription", "services"],
	},
	pipelines: [transcriptPipelinePack],
	orchestrations: [transcriptOrchestrationPack],
});

export const plugins: readonly Plugin[] = [transcriptPipelinePlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"pipeline.transcript": true;
	}
}
