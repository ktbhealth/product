import { definePlugin, type Plugin } from "@ktb/kernel";
import {
	DuplicatePipelineError,
	PipelineRegistryLive,
	UnknownStageError,
	type PipelinePack,
	type PipelineRegistry,
} from "@ktb/pipeline";
import type * as Layer from "effect/Layer";

/**
 * pipeline.core — the pipeline composition plugin.
 *
 * DATA-ONLY manifest plus the composition helpers every consumer of
 * `@ktb/pipeline` needs: plugin manifests carry their packs on the
 * `pipelines` field (PluginBase, @ktb/kernel), and the composition
 * root flattens them into one `PipelineRegistryLive` layer. The
 * helpers live here — not in @ktb/pipeline — because they speak the
 * plugin manifest shape (`Plugin[]`), which is kernel vocabulary the
 * engine package deliberately does not know.
 *
 * v1 scope: collection + layer construction only. Stage packs are
 * contributed by domain plugins (e.g. pipeline.transcript); a
 * platform admin UI for inspecting registered pipelines is out of
 * scope — `PipelineRegistry.list()` already exposes the defs.
 */

/** Flatten every plugin manifest's `pipelines` contributions into the
 * pack list `PipelineRegistryLive` registers — registration order is
 * plugin topo order (deps before dependents), and duplicate pipeline
 * ids surface as the registry's typed `DuplicatePipelineError` at layer
 * build, never mid-run. */
export const collectPipelinePacks = (plugins: readonly Plugin[]): readonly PipelinePack[] =>
	plugins.flatMap((p) => p.pipelines ?? []);

/** `PipelineRegistryLive` over the packs the given plugins contribute —
 * the one-liner composition roots use instead of hand-rolling
 * collect + register. The error channel stays typed
 * (`DuplicatePipelineError | UnknownStageError`): a pack whose def
 * references a missing stage implementation, or two plugins claiming
 * the same pipeline id, fails layer build loudly. */
export const pipelineRegistryLive = (
	plugins: readonly Plugin[],
): Layer.Layer<PipelineRegistry, DuplicatePipelineError | UnknownStageError> =>
	PipelineRegistryLive(collectPipelinePacks(plugins));

export const pipelineCorePlugin = definePlugin({
	id: "pipeline.core",
	meta: {
		name: "Pipeline",
		description:
			"Pipeline engine composition — collects pipeline packs contributed by plugin manifests into the shared PipelineRegistry.",
		keywords: ["platform", "services"],
	},
});

export const plugins: readonly Plugin[] = [pipelineCorePlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"pipeline.core": true;
	}
}
