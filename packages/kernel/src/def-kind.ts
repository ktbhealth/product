import type { JsonObject } from "effect/Schema";

import type { PluginContribution } from "./core.ts";
import type { Plugin } from "./contributions.ts";
import { buildDefOwnerIndex, type DefOwnerIndex } from "./enabled.ts";
import {
	collectKindContributions,
	GENERIC_CONTRIBUTION_SLOT,
	type ContributionKindDescriptor,
} from "./kinds.ts";

/**
 * Definition-kind factory (the `*.def` contribution pipeline).
 *
 * A family of plugins — views, api exposures, triggers, flows,
 * wizards, document collections, forms — each hand-copied the same
 * five-step pipeline: a `ContributionKindDescriptor` on the generic
 * `contributions` channel, an `assert*Def(value, context)` validator,
 * a `define*`/`*DefContribution` manifest pair, a `to*Definition`
 * narrowing helper that re-asserts wire payloads and stamps `owner`
 * from the contributing plugin, a `collect*Definitions(plugins)`
 * topo-ordered collector with a duplicate-key guard, and a
 * `make*Definitions(plugins)` composition-root builder attaching the
 * `DefOwnerIndex` enablement index. `defineDefKind` owns that shared
 * shape; each plugin keeps only its domain validator, key functions
 * and its `Context.Service` registry class (kernel stays
 * runtime-dependency-free, so the service tag — a per-plugin string
 * like `"@ktb/views/ViewDefinitions"` — is declared locally).
 *
 * Per-kind variance is data, not code:
 *
 * - `id`/`consumers` — the kind descriptor (`slot` is always
 *   `GENERIC_CONTRIBUTION_SLOT`, `ordering` always `"topo"`).
 * - `assert` — the domain validator `(value, context) => Def`; the
 *   context string is supplied by the factory (`<noun> "<id>"` for
 *   `define`, `plugin "…" contribution "…"` for `toDef`).
 * - `defId` — the def's identity used in `define` contexts and as the
 *   default manifest `id` (views/triggers/flows/wizards: `def.id`;
 *   api exposures: the collection name; document collections: `name`).
 * - `contributionId` — manifest `id` override when it differs from
 *   `defId` (api exposures key by URL path via `exposureKey`).
 * - `version` — manifest `version`; defaults to `"1"`, return
 *   `undefined` to omit the key entirely (wizard defs), or derive it
 *   from the def (document collections carry `String(def.version)`).
 * - `uniqueKey`/`uniqueLabel` — when present, `collect` throws on
 *   duplicate keys (`duplicate <label> "<key>" contributed by multiple
 *   plugins`). Kinds without the option skip the check (wizards
 *   dedupe downstream).
 * - `field` — the registry payload key `makeRegistry` returns
 *   (`{ [field]: defs, ownerIndex }`), matching each plugin's
 *   `Context.Service` shape (`views`, `triggers`, `exposures`, …).
 */

/** A def shape the factory can stamp `owner` onto — every `*.def`
 * payload carries an optional owning-plugin id. */
export interface DefKindOwner {
	readonly owner?: string;
}

export interface DefKindSpec<Def extends DefKindOwner, Field extends string = string> {
	/** Kind id registered on the generic `contributions` channel
	 * (`"view.def"`, `"api.expose"`, …). */
	readonly id: string;
	/** Descriptor consumers — free-form surface ids, same contract as
	 * {@link ContributionKindDescriptor.consumers}. */
	readonly consumers: readonly string[];
	/** Domain validator — `(value, context) => Def`, throwing on
	 * malformed payloads (packaging-bug contract). */
	readonly assert: (value: unknown, context: string) => Def;
	/** The def's identity for `define` contexts and the default
	 * manifest `id`. Return `unknown` — the factory stringifies, so
	 * malformed runtime input degrades to `"undefined"` in the context
	 * string exactly like the hand-rolled versions did. */
	readonly defId: (def: Def) => unknown;
	/** Singular noun for messages — `define` contexts read
	 * `<noun> "<defId>"` ("view", "api exposure", "trigger", …). */
	readonly noun: string;
	/** Registry payload key on the `makeRegistry` result. */
	readonly field: Field;
	/** Manifest `id` override — defaults to `String(defId(def))`. */
	readonly contributionId?: (def: Def) => string;
	/** Manifest `version` — defaults to `"1"`; return `undefined` to
	 * omit the key (wizards), or derive it (document collections). */
	readonly version?: (def: Def) => string | undefined;
	/** Duplicate-key predicate for `collect` — when present, a repeated
	 * key throws `duplicate <uniqueLabel ?? `${noun} id`> "<key>"
	 * contributed by multiple plugins`. */
	readonly uniqueKey?: (def: Def) => string;
	/** Label used in the duplicate-key error — defaults to
	 * `"${noun} id"` ("trigger id", "flow id"); kinds keyed by a
	 * derived value pass e.g. "view key"/"api exposure key"/
	 * "document collection". */
	readonly uniqueLabel?: string;
}

/** The composition-root registry value `makeRegistry` returns:
 * `{ [field]: defs, ownerIndex }` — structurally identical to each
 * plugin's hand-written `make*Definitions` return type. */
export type DefRegistry<Def, Field extends string> = {
	readonly [K in Field]: readonly Def[];
} & {
	readonly ownerIndex: DefOwnerIndex;
};

/** The surface {@link defineDefKind} returns. `Definitions` (the
 * `Context.Service` class) is intentionally NOT produced: kernel is
 * runtime-dependency-free, and each plugin's service tag is a
 * per-plugin string anyway — plugins declare the class locally and
 * feed it `makeRegistry`'s output. */
export interface DefKind<Def extends DefKindOwner, Field extends string> {
	/** The registered contribution kind descriptor. */
	readonly KIND: ContributionKindDescriptor;
	/** Assert a typed def at declaration time — packaging bugs surface
	 * at module load, not first render. */
	readonly define: (def: Def) => Def;
	/** Build the manifest `contributions[]` entry for a def. */
	readonly contribution: (def: Def) => PluginContribution;
	/** Narrow a collected `PluginContribution` back to a def —
	 * re-asserts `meta` and stamps `owner` from the plugin id when the
	 * manifest omits it. */
	readonly toDef: (entry: PluginContribution, pluginId: string) => Def;
	/** Collect every def of this kind across `plugins` (topo order —
	 * pass `orderPlugins`/`ctx.plugins` output). Throws on duplicate
	 * `uniqueKey`s when configured. */
	readonly collect: (plugins: readonly Plugin[]) => readonly Def[];
	/** Build the `{ [field]: defs, ownerIndex }` registry value the
	 * composition root provides to the plugin's `Context.Service`. */
	readonly makeRegistry: (plugins: readonly Plugin[]) => DefRegistry<Def, Field>;
}

/** Build the shared `*.def` contribution pipeline for one kind. See
 * the module doc for the per-kind knobs. */
export const defineDefKind = <Def extends DefKindOwner, Field extends string = string>(
	spec: DefKindSpec<Def, Field>,
): DefKind<Def, Field> => {
	const KIND: ContributionKindDescriptor = {
		id: spec.id,
		slot: GENERIC_CONTRIBUTION_SLOT,
		consumers: spec.consumers,
		ordering: "topo",
	};
	const versionOf = spec.version ?? (() => "1");
	const uniqueLabel = spec.uniqueLabel ?? `${spec.noun} id`;

	const define = (def: Def): Def => spec.assert(def, `${spec.noun} "${String(spec.defId(def))}"`);

	const contribution = (def: Def): PluginContribution => {
		const id = spec.contributionId?.(def) ?? String(spec.defId(def));
		const version = versionOf(def);
		return {
			kind: KIND.id,
			id,
			...(version === undefined ? {} : { version }),
			meta: def as unknown as JsonObject,
		};
	};

	const toDef = (entry: PluginContribution, pluginId: string): Def => {
		const def = spec.assert(entry.meta, `plugin "${pluginId}" contribution "${entry.id}"`);
		return def.owner === undefined ? ({ ...def, owner: pluginId } as Def) : def;
	};

	const collect = (plugins: readonly Plugin[]): readonly Def[] => {
		const collected = collectKindContributions(plugins, KIND).map(({ plugin, payload }) =>
			toDef(payload as PluginContribution, plugin.id),
		);
		if (spec.uniqueKey !== undefined) {
			const seen = new Set<string>();
			for (const def of collected) {
				const key = spec.uniqueKey(def);
				if (seen.has(key)) {
					throw new Error(`duplicate ${uniqueLabel} "${key}" contributed by multiple plugins`);
				}
				seen.add(key);
			}
		}
		return collected;
	};

	const makeRegistry = (plugins: readonly Plugin[]): DefRegistry<Def, Field> => {
		const defs = collect(plugins);
		return {
			[spec.field]: defs,
			ownerIndex: buildDefOwnerIndex(plugins),
		} as DefRegistry<Def, Field>;
	};

	return { KIND, define, contribution, toDef, collect, makeRegistry };
};
