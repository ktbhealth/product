import * as Context from "effect/Context";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { Plugin, PluginContribution } from "@ktb/kernel";
import { GENERIC_CONTRIBUTION_SLOT, type ContributionKindDescriptor } from "@ktb/kernel";

/**
 * Route registry (PL-011 / P-106): route identity as first-class data.
 * Every addressable path gets a stable string key; nav links, guards
 * and cross-plugin references resolve through `Routes.route(key,
 * params)` / `Routes.match(path)` instead of hardcoding path literals.
 *
 * Two channels feed the registry, both collected once at composition
 * from the (topo-ordered) plugin registry — same injection pattern as
 * `DocumentCollections`/`ViewDefinitions` in @ktb/app-host:
 *
 * 1. EXPLICIT `route` contributions — `contributions[]` entries with
 *    `kind: "route"` (see {@link routeContribution}). This is the
 *    channel for paths that are NOT page descriptors: file-route
 *    subtrees (`plugins/<pkg>/src/routes/**`, `physical()` mounts) and any
 *    `:param` addressable path. `entry.id` is the route key; `meta`
 *    carries `{ path, params?, portal?, context? }`.
 * 2. DERIVED page defs — every `panel.pages`/`pages` descriptor
 *    auto-registers under `page.routeKey ?? "<pluginId>/<pageId>"`,
 *    so the whole contributed-page surface is matchable with zero
 *    per-plugin ceremony. `routeKey` (kernel `Page`/`PanelPage`) lets a
 *    plugin claim a clean typed key instead of the derived one.
 *
 * Compile-time key typing follows the `PluginRegistry` pattern
 * (@ktb/kernel core.ts): each plugin augments
 *
 *   declare module "@ktb/platform/routes" {
 *   	interface RouteRegistry { "my.route": "/my/path/:id" }
 *   }
 *
 * so `route()` only accepts declared keys and infers the `:param`
 * names from the path literal — unknown keys and missing/extra params
 * fail typecheck. The augmentation only applies where the module is
 * imported (same caveat as PluginRegistry); runtime collection is the
 * backstop.
 *
 * Path template syntax is router-neutral: literal segments, `:name`
 * single-segment params, and a trailing `/*` wildcard (same syntax as
 * page descriptors and chrome `when` paths). TanStack `$param` file
 * routes map to `:param` in defs.
 */

/** Registry of route keys known at compile time — augmented per plugin
 * via `declare module "@ktb/platform/routes"`. Values are path
 * templates (":param" segments, optional trailing "/*"). */
export interface RouteRegistry {}

export type RouteKey = Extract<keyof RouteRegistry, string>;

/** The declared path template for a key — the literal the plugin
 * augmented with. */
export type RoutePath<K extends RouteKey> = RouteRegistry[K];

/** Extract `:name` param names from a path template literal. */
export type PathParams<
	P extends string,
	Out extends string = never,
> = P extends `${infer _Head}/:${infer Tail}`
	? Tail extends `${infer Name}/${infer Rest}`
		? PathParams<`/${Rest}`, Out | Name>
		: PathParams<"", Out | Tail>
	: Out;

/** Params `route(key, …)` requires: one string|number per `:name`
 * segment of the key's path template; `undefined` for param-less
 * paths (the argument is then omitted). */
export type RouteParams<K extends RouteKey> = [PathParams<RoutePath<K>>] extends [never]
	? undefined
	: Record<PathParams<RoutePath<K>>, string | number>;

/** A resolved route definition — the runtime half of a registry key. */
export interface RouteDefinition {
	/** Stable route key — the `contributions[].id` for explicit defs,
	 * `page.routeKey ?? "<pluginId>/<pageId>"` for derived page defs. */
	readonly key: string;
	/** Path template: literal segments, `:name` params, optional
	 * trailing `/*` wildcard. */
	readonly path: string;
	/** Param names declared by the contributing plugin (meta only —
	 * matching/substitution work off the path template itself). */
	readonly params?: readonly string[];
	/** Portal instance this route lives under ("platform", a
	 * /portal/<id> instance id), when the contributor knows it. */
	readonly portal?: string;
	/** Shell context hint ("app" | "portal"), mirroring `Page.context`. */
	readonly context?: "app" | "portal";
	/** Plugin that contributed the def (derived page defs carry the
	 * page's owner; explicit defs the contribution's owner). */
	readonly pluginId: string;
}

/** What `Routes.match(path)` returns: the winning route key plus the
 * `:param` values extracted from the concrete path (empty for exact
 * and wildcard matches). */
export interface RouteMatch {
	readonly key: string;
	readonly params: Readonly<Record<string, string>>;
}

export interface RoutesShape {
	/** Resolve a route key to a concrete path. `params` fills `:name`
	 * segments (URL-encoded); keys whose template is a wildcard cannot
	 * be routed — there is no single path to return. Throws on unknown
	 * keys, wildcard templates and missing params (the type signature
	 * rules all three out for declared keys; the runtime checks are the
	 * backstop for untyped callers). */
	readonly route: <K extends RouteKey>(
		key: K,
		...args: RouteParams<K> extends undefined ? [] : [params: RouteParams<K>]
	) => string;
	/** Resolve a concrete request path to its route: exact-path defs
	 * win, then `:param` patterns, then `/*` wildcards — longest /
	 * most-specific base wins, ties keep registration (topo) order.
	 * Returns undefined when nothing matches. */
	readonly match: (path: string) => RouteMatch | undefined;
	/** The registered definition for `key`, or undefined. */
	readonly get: (key: string) => RouteDefinition | undefined;
	/** Every registered definition, in registration order. */
	readonly list: () => readonly RouteDefinition[];
}

/**
 * Shared route registry, provided once by the composition root
 * (@ktb/app-host merges `RoutesLive` into `core`) from the discovered
 * plugin registry — same contract as the other definition registries
 * (DocumentCollections, ViewDefinitions, …). Consumed via the `Routes`
 * service in loaders/server fns, or built standalone with
 * {@link makeRoutes} for tests and client surfaces.
 */
export class Routes extends Context.Service<Routes, RoutesShape>()("@ktb/platform/Routes") {}

/** Kind id for explicit route contributions on the generic
 * `contributions` channel (P-070) — no dedicated Plugin field, so zero
 * kernel contract churn. Consumers collect via
 * {@link collectRouteDefinitions}. */
export const ROUTE_KIND = "route" satisfies string;

export const ROUTE_CONTRIBUTION_KIND: ContributionKindDescriptor = {
	id: ROUTE_KIND,
	slot: GENERIC_CONTRIBUTION_SLOT,
	consumers: ["app-host.server", "plugin-manager"],
	ordering: "topo",
};

/** Serializable meta carried by a `route` contribution entry — the
 * JSON-Schema-validated shape {@link collectRouteDefinitions} decodes.
 * `path` is the route template; `params` optionally names the `:param`
 * segments for tooling display (the template is authoritative). */
export const RouteContributionMeta = Schema.Struct({
	path: Schema.String,
	params: Schema.optionalKey(Schema.Array(Schema.String)),
	portal: Schema.optionalKey(Schema.String),
	context: Schema.optionalKey(Schema.Literals(["app", "portal"])),
});
export type RouteContributionMeta = Schema.Schema.Type<typeof RouteContributionMeta>;

/** Build a `route` contribution entry for a plugin manifest:
 *
 *   contributions: [routeContribution("consultations.detail", {
 *   	path: "/consultations/:id",
 *   	params: ["id"],
 *   })]
 *
 * `key` is the route key — declare it (with the same path literal) in
 * `RouteRegistry` for compile-time `route()` typing. */
export const routeContribution = (
	key: string,
	meta: RouteContributionMeta,
): PluginContribution => ({ kind: ROUTE_KIND, id: key, meta: { ...meta } });

const isWildcard = (path: string): boolean => path.endsWith("/*");

/** Segment-wise pattern compile: `:name` binds one segment, trailing
 * `/*` binds the rest. Returns null for templates match() cannot
 * serve (bare "*" mid-path is not supported). */
interface CompiledPattern {
	readonly raw: string;
	readonly segments: readonly string[];
	readonly wildcard: boolean;
}

const compilePattern = (path: string): CompiledPattern => {
	const wildcard = isWildcard(path);
	const base = wildcard ? path.slice(0, -2) : path;
	const segments = base.split("/").filter((s) => s.length > 0);
	return { raw: path, segments, wildcard };
};

/** Does `pattern` match `path`? On success returns the bound `:param`
 * values; `:name` segments require a non-empty segment, `/*` matches
 * zero or more trailing segments. */
const matchPattern = (
	pattern: CompiledPattern,
	path: string,
): Readonly<Record<string, string>> | null => {
	const parts = path.split("/").filter((s) => s.length > 0);
	const params: Record<string, string> = {};
	const fixed = pattern.segments.length;
	if (pattern.wildcard) {
		if (parts.length < fixed) return null;
	} else if (parts.length !== fixed) {
		return null;
	}
	for (let i = 0; i < fixed; i++) {
		const seg = pattern.segments[i];
		const actual = parts[i];
		if (seg.startsWith(":")) {
			try {
				params[seg.slice(1)] = decodeURIComponent(actual);
			} catch {
				// Malformed percent-encoding ("%", "%zz", truncated UTF-8
				// escapes) — the segment can't be decoded, so the pattern
				// doesn't match (fail closed, like every other miss).
				return null;
			}
		} else if (seg !== actual) {
			return null;
		}
	}
	return params;
};

/** Specificity rank for match(): exact literals beat `:param`
 * patterns beat wildcards; among equal ranks the longer (more
 * segments) pattern wins, then registration order. */
const rankOf = (def: RouteDefinition): number => {
	if (isWildcard(def.path)) return 1;
	return def.path.includes(":") ? 2 : 3;
};

/** Build the route/match surface over `defs` (registration order =
 * priority order for ties). Pure — no Effect, safe on both edges. */
export const makeRoutes = (defs: readonly RouteDefinition[]): RoutesShape => {
	const byKey = new Map<string, RouteDefinition>();
	const compiled = defs.map((def) => ({ def, pattern: compilePattern(def.path) }));
	for (const { def } of compiled) byKey.set(def.key, def);
	return {
		route: (key, ...args) => {
			const def = byKey.get(key as string);
			if (def === undefined) {
				throw new Error(`unknown route key "${String(key)}"`);
			}
			if (isWildcard(def.path)) {
				throw new Error(`route key "${def.key}" is a wildcard — it has no single path`);
			}
			const values = (args[0] ?? {}) as Record<string, unknown>;
			return def.path
				.split("/")
				.map((seg) => {
					if (!seg.startsWith(":")) return seg;
					const name = seg.slice(1);
					const value = values[name];
					if (value === undefined || value === null || value === "") {
						throw new Error(`route "${def.key}" is missing param "${name}"`);
					}
					return encodeURIComponent(String(value));
				})
				.join("/");
		},
		match: (path) => {
			const normalized = path.startsWith("/") ? path : `/${path}`;
			let best: { def: RouteDefinition; params: Record<string, string> } | undefined;
			let bestRank = -1;
			let bestSegments = -1;
			for (const { def, pattern } of compiled) {
				const params = matchPattern(pattern, normalized);
				if (params === null) continue;
				const rank = rankOf(def);
				const segments = pattern.segments.length;
				// `compiled` iterates in registration order — strictly-greater
				// comparisons keep the FIRST def on ties (topo order wins).
				if (rank > bestRank || (rank === bestRank && segments > bestSegments)) {
					best = { def, params: { ...params } };
					bestRank = rank;
					bestSegments = segments;
				}
			}
			return best === undefined ? undefined : { key: best.def.key, params: best.params };
		},
		get: (key) => byKey.get(key),
		list: () => defs,
	};
};

/**
 * Collect every route definition contributed by `plugins` (expected in
 * topo order — pass the output of `orderPlugins`). Explicit `route`
 * contributions are Schema-decoded; page descriptors derive defs
 * automatically. Duplicate keys are a packaging bug and throw — same
 * fail-loud contract as `ElementKinds.register`. Enablement is NOT
 * filtered here: defs are static composition data (the same contract
 * DocumentCollections documents); dispatch gates own enablement.
 */
export const collectRouteDefinitions = (plugins: readonly Plugin[]): readonly RouteDefinition[] => {
	const defs: RouteDefinition[] = [];
	const seen = new Set<string>();
	const add = (def: RouteDefinition): void => {
		if (seen.has(def.key)) {
			throw new Error(`duplicate route key "${def.key}"`);
		}
		seen.add(def.key);
		defs.push(def);
	};
	for (const plugin of plugins) {
		for (const entry of plugin.contributions ?? []) {
			if (entry.kind !== ROUTE_KIND) continue;
			const decoded = Schema.decodeUnknownResult(RouteContributionMeta)(entry.meta ?? {});
			if (Result.isFailure(decoded)) {
				throw new Error(
					`invalid "${ROUTE_KIND}" contribution "${entry.id}" on plugin "${plugin.id}": ${String(decoded.failure)}`,
				);
			}
			const meta = decoded.success;
			add({
				key: entry.id,
				path: meta.path,
				pluginId: plugin.id,
				...(meta.params === undefined ? {} : { params: meta.params }),
				...(meta.portal === undefined ? {} : { portal: meta.portal }),
				...(meta.context === undefined ? {} : { context: meta.context }),
			});
		}
		// Derived page defs: panel.pages are portal pages by definition;
		// pages carry their own context hint (already defaulted by
		// collectPages — here the raw descriptor value is enough for
		// the registry's informational `context` field).
		const pageDefs: ReadonlyArray<{
			id: string;
			path: string;
			routeKey?: string;
			context?: "app" | "portal";
		}> = [
			...(plugin.panel?.pages ?? []).map((page) => ({
				id: page.id,
				path: page.path,
				routeKey: page.routeKey,
				context: "portal" as const,
			})),
			...(plugin.pages ?? []).map((page) => ({
				id: page.id,
				path: page.path,
				routeKey: page.routeKey,
				context: page.context,
			})),
		];
		for (const page of pageDefs) {
			add({
				key: page.routeKey ?? `${plugin.id}/${page.id}`,
				path: page.path,
				pluginId: plugin.id,
				...(page.context === undefined ? {} : { context: page.context }),
			});
		}
	}
	return defs;
};
