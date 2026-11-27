import { WorkflowIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { Db } from "@ktb/db";
import { definePlugin, type Plugin } from "@ktb/kernel";
import {
	builtinKinds,
	DuplicateKindError,
	DuplicateOrchestrationError,
	getOrchestrationDef,
	listOrchestrationDefs,
	OrchestratorRegistry,
	OrchestratorRegistryLive,
	UnknownKindError,
	type OrchestrationKind,
	type OrchestrationPack,
} from "@ktb/orchestrator";
import {
	DuplicatePipelineError,
	PipelineRegistryLive,
	UnknownStageError,
	type PipelinePack,
	type PipelineRegistry,
} from "@ktb/pipeline";
import { PlatformAdmin, platformPanelPlugin } from "@ktb/platform";
import type * as Layer from "effect/Layer";

import { orchestrationListRow, type OrchestrationDefRecordWire } from "./fns.ts";
import { OrchestrationEditorPanelPage, PipelinesAdminPage } from "./platform-page.tsx";

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

/** Flatten every plugin manifest's `orchestrations` contributions into
 * the pack list `orchestratorRegistryLive` registers — same topo-order
 * collection contract as {@link collectPipelinePacks}. Each pack is
 * `{def?, kinds}`: the optional def validates against ALL collected
 * kinds at
 * layer build (a node kind no pack provides fails loudly), so kind
 * order across packs does not matter. */
export const collectOrchestratorPacks = (
	plugins: readonly Plugin[],
): readonly OrchestrationPack[] => plugins.flatMap((p) => p.orchestrations ?? []);

/** `OrchestratorRegistryLive` over the packs the given plugins
 * contribute — kinds first (deduped across packs is NOT attempted:
 * a kind id claimed by two packs is a `DuplicateKindError` at layer
 * build, same loud-failure contract as pipeline registration), then
 * defs in plugin order. Packs may be kinds-only (`def` absent —
 * shared kind vocabulary like @ktb/orchestrator-ai's `ai` kind) and
 * contribute no def. `extraKinds` lets the composition root seed
 * engine vocabulary (`builtinKinds`) or host kinds before the pack
 * kinds; pack kinds may not shadow them (same duplicate rule). The
 * error channel stays typed (`DuplicateKindError | UnknownKindError |
 * DuplicateOrchestrationError`). */
export const orchestratorRegistryLive = (
	plugins: readonly Plugin[],
	extraKinds: readonly OrchestrationKind[] = [],
): Layer.Layer<
	OrchestratorRegistry,
	DuplicateKindError | UnknownKindError | DuplicateOrchestrationError
> => {
	const packs = collectOrchestratorPacks(plugins);
	return OrchestratorRegistryLive(
		[...extraKinds, ...packs.flatMap((pack) => pack.kinds)],
		packs.flatMap((pack) => (pack.def === undefined ? [] : [pack.def])),
	);
};

export const pipelineCorePlugin = definePlugin({
	id: "pipeline.core",
	meta: {
		name: "Pipeline",
		description:
			"Pipeline engine composition — collects pipeline packs contributed by plugin manifests into the shared PipelineRegistry.",
		keywords: ["platform", "services"],
	},
});

// ---------------------------------------------------------------------------
// Pipelines admin (P-120 phase 4)
// ---------------------------------------------------------------------------

/** Kind ids for the editor palette — the live OrchestratorRegistry when
 * the composition root provides one, `builtinKinds` otherwise (the
 * registry is not wired into every runtime yet; the editor must still
 * offer the shipped kinds). Same resolution as `listOrchestrationKindsFn`. */
const kindIds = Effect.gen(function* () {
	const registry = yield* Effect.serviceOption(OrchestratorRegistry);
	const kinds = Option.isSome(registry)
		? registry.value.listKinds().map((kind) => kind.id)
		: builtinKinds.map((kind) => kind.id);
	return [...new Set(kinds)].sort();
});

const EDITOR_BASE = "/platform/pipelines";

interface EditorLoaderData {
	readonly mode: "new" | "edit";
	/** Wire record — data-only def; `OrchestrationDefRecord` re-typed for
	 * serialization (the `handler` field can never survive a JSON round
	 * trip, so it must not appear in loader data). */
	readonly def: OrchestrationDefRecordWire | null;
	readonly kinds: readonly string[];
}

/**
 * pipeline.admin.chrome — the /platform/pipelines sidebar entry in the
 * console's portal.sidebar region ("Runtime" group, next to the plugin
 * manager). Mirrors ./client.ts; parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const pipelineAdminChromePlugin = definePlugin({
	id: "pipeline.admin.chrome",
	requiredDeps: [platformPanelPlugin.id],
	meta: {
		keywords: ["platform", "ui", "admin"],
		name: "Pipelines",
		description: "Orchestration def administration",
		icon: WorkflowIcon,
	},
	chrome: [
		{
			id: "pipeline.admin.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/pipelines",
					label: "Pipelines",
					icon: WorkflowIcon,
					group: "Runtime",
				},
			},
		},
	],
});

/**
 * pipeline.admin.panel — the orchestration admin pages:
 *
 * - `/platform/pipelines` (exact) — the def table; the loader reads
 *   `orchestration_defs` through the durable store helpers behind
 *   PlatformAdmin.requireAdmin (the /platform layout gate already ran —
 *   defense in depth).
 * - `/platform/pipelines/*` (wildcard) — the React Flow editor. The
 *   path suffix selects the def: "new" opens an empty def, anything
 *   else is the def id (the def is the PK; ids may contain slashes, so
 *   the whole remainder is the id). Same wildcard mechanics as the
 *   DB-backed `pages` descriptors — `findPage` resolves longest-base.
 *
 * Loaders are Effects run under the session principal; Forbidden
 * collapses to the empty/missing view, never a 500.
 */
export const pipelineAdminPanelPlugin = definePlugin({
	id: "pipeline.admin.panel",
	requiredDeps: [platformPanelPlugin.id],
	meta: {
		keywords: ["platform", "ui", "admin"],
		name: "Pipelines",
		description: "Orchestration def administration",
		icon: WorkflowIcon,
	},
	panel: {
		pages: [
			{
				id: "pipeline.admin.list",
				path: "/platform/pipelines",
				component: PipelinesAdminPage,
				loader: () =>
					Effect.gen(function* () {
						const platformAdmin = yield* PlatformAdmin;
						yield* platformAdmin.requireAdmin();
						const db = yield* Db;
						const records = yield* Effect.promise(() =>
							listOrchestrationDefs(db, { enabledOnly: false }),
						);
						return { rows: records.map(orchestrationListRow) };
					}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ rows: [] }))),
			},
			{
				id: "pipeline.admin.editor",
				path: `${EDITOR_BASE}/*`,
				component: OrchestrationEditorPanelPage,
				loader: (path: string) =>
					Effect.gen(function* () {
						const platformAdmin = yield* PlatformAdmin;
						yield* platformAdmin.requireAdmin();
						const kinds = yield* kindIds;
						const suffix = path.startsWith(`${EDITOR_BASE}/`)
							? path.slice(EDITOR_BASE.length + 1)
							: "";
						if (suffix === "" || suffix === "new") {
							return { mode: "new", def: null, kinds } satisfies EditorLoaderData;
						}
						const db = yield* Db;
						// Malformed percent-encoding degrades to the raw
						// suffix — the store simply finds no such id.
						let id = suffix;
						try {
							id = decodeURIComponent(suffix);
						} catch {
							/* keep raw suffix */
						}
						const record = yield* Effect.promise(() => getOrchestrationDef(db, id));
						return {
							mode: "edit",
							def: record === null ? null : (record as OrchestrationDefRecordWire),
							kinds,
						} satisfies EditorLoaderData;
					}).pipe(
						Effect.catchTag("Forbidden", () =>
							Effect.succeed({ mode: "edit", def: null, kinds: [] } satisfies EditorLoaderData),
						),
					),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	pipelineCorePlugin,
	pipelineAdminChromePlugin,
	pipelineAdminPanelPlugin,
];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"pipeline.core": true;
		"pipeline.admin.chrome": true;
		"pipeline.admin.panel": true;
	}
}
