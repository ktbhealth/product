import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runOrchestration } from "./runner.ts";
import {
	DuplicateKindError,
	DuplicateOrchestrationError,
	OrchestrationRunError,
	UnknownKindError,
	UnknownOrchestrationError,
	type OrchestrationDef,
	type OrchestrationKind,
	type OrchestrationRunResult,
	type RunOptions,
} from "./types.ts";

/**
 * registry.ts — the orchestrator registry and run entry point.
 *
 * `OrchestratorRegistry` is an Effect service tag (same `Context.Service`
 * idiom as `PipelineRegistry` and the eval ports) holding two in-memory
 * maps: kind id → {@link OrchestrationKind} and orchestration id →
 * {@link OrchestrationDef}. `registerKind`/`registerDef` are
 * synchronous and throw typed errors — registration is a programming
 * error surfaced at composition time, not a run-time failure.
 *
 * `registerDef` validates that every node resolves a kind: a node with
 * an inline `handler` is self-contained; otherwise `node.kind` must
 * name a registered kind (checked here, never mid-run).
 */

/** The registry surface. `registerKind`/`registerDef`/`get`/`has`/
 * `listDefs`/`listKinds` are synchronous (typed throws,
 * ContributionRegistry-style); `run` is the only Effect — it drives the
 * event loop in {@link runOrchestration}. */
export interface OrchestratorRegistryService {
	/** Register a node-kind handler. Throws {@link DuplicateKindError}
	 * when `kind.id` is already registered. */
	readonly registerKind: (kind: OrchestrationKind) => void;
	/** Register an orchestration def. Throws {@link
	 * DuplicateOrchestrationError} when `def.id` is already registered
	 * and {@link UnknownKindError} when a node has no inline `handler`
	 * and its `kind` is not registered. */
	readonly registerDef: (def: OrchestrationDef) => void;
	/** The registered def for `id`. Throws {@link
	 * UnknownOrchestrationError} when absent. */
	readonly get: (id: string) => OrchestrationDef;
	readonly has: (id: string) => boolean;
	/** All registered defs in registration order. */
	readonly listDefs: () => readonly OrchestrationDef[];
	/** All registered kinds in registration order. */
	readonly listKinds: () => readonly OrchestrationKind[];
	/** Run the orchestration `id`. `input` is optional — an
	 * {@link OrchestrationEvent} is used as the initial event, a plain
	 * object becomes an "input" event, and absent input yields the
	 * synthetic `start` event. Fails with {@link OrchestrationRunError}
	 * on an unknown id, an unresolvable node kind, or an exhausted event
	 * budget. */
	readonly run: (
		id: string,
		input?: unknown,
		opts?: RunOptions,
	) => Effect.Effect<OrchestrationRunResult, OrchestrationRunError>;
}

export class OrchestratorRegistry extends Context.Service<
	OrchestratorRegistry,
	OrchestratorRegistryService
>()("@ktb/orchestrator/OrchestratorRegistry") {}

/** Build a standalone registry service value (no Effect context
 * needed) — tests and non-Effect callers use this directly;
 * {@link OrchestratorRegistryLive} wraps it as a Layer. `kinds` are
 * pre-registered; a duplicate kind id throws
 * {@link DuplicateKindError}. */
export const makeOrchestratorRegistry = (
	kinds: readonly OrchestrationKind[] = [],
): OrchestratorRegistryService => {
	const defs = new Map<string, OrchestrationDef>();
	const kindMap = new Map<string, OrchestrationKind>();

	const registerKind = (kind: OrchestrationKind): void => {
		if (kindMap.has(kind.id)) {
			throw new DuplicateKindError({ kind: kind.id });
		}
		kindMap.set(kind.id, kind);
	};
	for (const kind of kinds) {
		registerKind(kind);
	}

	return {
		registerKind,

		registerDef(def) {
			if (defs.has(def.id)) {
				throw new DuplicateOrchestrationError({ orchestrationId: def.id });
			}
			for (const node of def.nodes) {
				if (node.handler === undefined && !kindMap.has(node.kind)) {
					throw new UnknownKindError({
						kind: node.kind,
						nodeId: node.id,
						orchestrationId: def.id,
					});
				}
			}
			defs.set(def.id, def);
		},

		get(id) {
			const def = defs.get(id);
			if (def === undefined) {
				throw new UnknownOrchestrationError({ orchestrationId: id });
			}
			return def;
		},

		has(id) {
			return defs.has(id);
		},

		listDefs() {
			return [...defs.values()];
		},

		listKinds() {
			return [...kindMap.values()];
		},

		run(id, input, opts) {
			const def = defs.get(id);
			if (def === undefined) {
				return Effect.fail(
					new OrchestrationRunError({
						orchestrationId: id,
						message: `unknown orchestration: ${id}`,
						trace: [],
					}),
				);
			}
			return runOrchestration(def, kindMap, input, opts);
		},
	};
};

/** Layer that registers every kind and def at build time — the
 * composition-root entry point (a plugin's services layer or the host
 * runtime provides `OrchestratorRegistryLive(kinds, defs)` once,
 * collected from plugin manifests). Registration failures surface as
 * the layer's error channel, preserving the typed errors instead of
 * defecting. */
export const OrchestratorRegistryLive = (
	kinds: readonly OrchestrationKind[] = [],
	defs: readonly OrchestrationDef[] = [],
): Layer.Layer<
	OrchestratorRegistry,
	DuplicateKindError | UnknownKindError | DuplicateOrchestrationError
> =>
	Layer.effect(
		OrchestratorRegistry,
		Effect.gen(function* () {
			// makeOrchestratorRegistry throws DuplicateKindError on
			// duplicate seed kinds — route it through the typed channel.
			const registry = yield* Effect.try({
				try: () => makeOrchestratorRegistry(kinds),
				catch: (cause) => cause as DuplicateKindError,
			});
			for (const def of defs) {
				yield* Effect.try({
					try: () => registry.registerDef(def),
					catch: (cause) => cause as UnknownKindError | DuplicateOrchestrationError,
				});
			}
			return registry;
		}),
	);
