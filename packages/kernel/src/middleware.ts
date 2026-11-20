import type * as Effect from "effect/Effect";

import type { Plugin, PortalInstance } from "./contributions.ts";
import type { PackagedPlugin } from "./enabled.ts";
import { collectKindContributions, MIDDLEWARE_KIND } from "./kinds.ts";

/**
 * Ordered request-middleware contract (PL-015 / P-110).
 *
 * Plugins contribute stages via the dedicated `middleware` field
 * (`MiddlewarePlugin` in ./contributions.ts); the host edge collects
 * them with `collectMiddlewareStages`, orders them with
 * `orderMiddlewareEntries` and runs the effective chain per request —
 * see `effectiveMiddlewareChain`. Stages are LINEAR with early
 * return: each handler sees the request context, returns a verdict,
 * and the first non-`continue` verdict ends the chain (the page
 * dispatchers map `deny` to not-found and `redirect` to a router
 * redirect — same outcomes page `guard`s produce today).
 *
 * This module is dependency-free (type-only effect/kernel imports) so
 * BOTH registries and the admin page's client bundle can use the pure
 * helpers; handlers themselves are server-only Effects and never
 * reach the client manifest.
 */

/** Where a stage applies. Every declared field must match (AND); an
 * absent/empty scope matches every request. `path` is a path glob in
 * the same syntax as page/chrome paths: an exact path, `"*"` for all,
 * or `"base/*"` for a subtree (the bare base itself counts).
 * `routeKey` is the winning page descriptor's registered path (e.g.
 * "/platform/pubsub" or a wildcard "/*"), matched exactly — it is
 * what binds a stage to a contributed route rather than a raw URL.
 * `context` is the dispatch shell ("app" | "portal") or any
 * host-defined bucket. */
export interface MiddlewareScope {
	readonly routeKey?: string;
	readonly context?: string;
	readonly path?: string;
}

/** Request facts a stage scopes/inspects. `path` is the concrete
 * request path; `routeKey`/`context` are set when the request resolved
 * a contributed page (page dispatch), absent for opaque requests. */
export interface MiddlewareRequest {
	readonly path: string;
	readonly context?: string;
	readonly routeKey?: string;
}

/** Mutable per-request bag stages share. The built-in principal stage
 * stores the resolved session/acting user under `user`; later stages
 * (and the page guard/loader dispatch) read it. Typed `unknown` —
 * kernel stays session-shape agnostic. */
export interface MiddlewareState {
	user?: unknown;
}

/** Everything a stage handler sees. `owner` names the plugin that
 * owns the matched route descriptor (enablement/audit stages read
 * it); `subject` selects which principal the built-in session stage
 * resolves ("session" account vs doctor-resolved acting user);
 * `search` is the request's parsed URL search when the dispatcher
 * supplies one. */
export interface MiddlewareContext extends MiddlewareRequest {
	readonly search?: Readonly<Record<string, unknown>>;
	readonly owner?: {
		readonly pluginId: string;
		readonly pkg?: string;
	};
	readonly subject?: "session" | "doctor";
	/** Discovered plugin registry — package-granular enablement stages
	 * resolve `owner.pkg` membership through it (`packageLive`). The
	 * dispatch edge always supplies it; absent, pkg-scoped checks fail
	 * closed. */
	readonly plugins?: readonly PackagedPlugin[];
	/** The portal instance the request path resolved to (page
	 * dispatch), when one exists — audience stages read its `audience`
	 * rule. Absent on app paths and unregistered instances. */
	readonly portalInstance?: PortalInstance;
	readonly state: MiddlewareState;
}

/** Stage outcome: `continue` lets the chain proceed; `deny` rejects
 * the request (dispatchers render not-found); `redirect` short-
 * circuits with a navigation target. */
export type MiddlewareVerdict =
	| { readonly type: "continue" }
	| { readonly type: "deny"; readonly reason?: string }
	| { readonly type: "redirect"; readonly to: string; readonly replace?: boolean };

export const middlewareContinue = (): MiddlewareVerdict => ({ type: "continue" });

export const middlewareDeny = (reason?: string): MiddlewareVerdict => ({
	type: "deny",
	...(reason === undefined ? {} : { reason }),
});

export const middlewareRedirect = (to: string, replace?: boolean): MiddlewareVerdict => ({
	type: "redirect",
	to,
	...(replace === undefined ? {} : { replace }),
});

/** Stage handler: an Effect over the request context returning a
 * verdict. Runs under the bound principal once the principal stage
 * has resolved one (host `run`/`runAs`), so handlers may yield any
 * composed service. */
export type MiddlewareHandler = (
	ctx: MiddlewareContext,
) => Effect.Effect<MiddlewareVerdict, unknown, unknown>;

/** One contributed stage. `order` sorts ascending — absent means
 * {@link MIDDLEWARE_ORDER_DEFAULT} so plugin stages slot between the
 * built-in gates (orders < 100) and any later policy; ties break by
 * plugin topo order then declaration index (see
 * `orderMiddlewareEntries`). `handler` runs as an Effect — under the
 * bound principal once the principal stage has resolved one, via the
 * host's `run`/`runAs` — and returns a verdict. */
export interface MiddlewareStage {
	readonly id: string;
	readonly order?: number;
	readonly scope?: MiddlewareScope;
	readonly handler: MiddlewareHandler;
}

/** Default `order` for stages that don't declare one — after the
 * built-in principal/enabled/audience gates, before page guards. */
export const MIDDLEWARE_ORDER_DEFAULT = 100;

/** A stage plus its registry provenance — what the collector emits
 * and the admin inspector displays. `origin` distinguishes host
 * built-ins (always enabled, `pluginId` "app-host") from plugin
 * contributions; `pluginIndex`/`entryIndex` are the deterministic
 * tie-breakers (built-ins carry `pluginIndex: -1` so they precede
 * plugin stages on equal order). */
export interface MiddlewareStageEntry extends MiddlewareStage {
	readonly pluginId: string;
	readonly pkg?: string;
	readonly origin: "plugin" | "builtin";
	readonly pluginIndex: number;
	readonly entryIndex: number;
}

/** Serializable stage row for admin surfaces — the handler is
 * stripped (it is a server-only function and must never cross the
 * wire). */
export interface MiddlewareStageInfo {
	readonly id: string;
	readonly order?: number;
	readonly scope?: MiddlewareScope;
	readonly pluginId: string;
	readonly pkg?: string;
	readonly origin: "plugin" | "builtin";
	readonly pluginIndex: number;
	readonly entryIndex: number;
}

/** One registered page route the inspector can resolve a chain for. */
export interface MiddlewareRouteInfo {
	readonly path: string;
	readonly context: string;
	readonly routeKey: string;
}

/** Strip the handler off an entry — the admin/service view of a stage. */
export const middlewareStageInfo = (entry: MiddlewareStageEntry): MiddlewareStageInfo => ({
	id: entry.id,
	...(entry.order === undefined ? {} : { order: entry.order }),
	...(entry.scope === undefined ? {} : { scope: entry.scope }),
	pluginId: entry.pluginId,
	...(entry.pkg === undefined ? {} : { pkg: entry.pkg }),
	origin: entry.origin,
	pluginIndex: entry.pluginIndex,
	entryIndex: entry.entryIndex,
});

/** Path-glob match in page/chrome syntax: exact equality, `"*"` for
 * every path, `"base/*"` for the subtree (bare base included). */
export const middlewarePathMatches = (pattern: string, path: string): boolean => {
	if (pattern === "*") return true;
	if (pattern.endsWith("/*")) {
		const base = pattern.slice(0, -2);
		return base === "" ? path.startsWith("/") : path === base || path.startsWith(`${base}/`);
	}
	return pattern === path;
};

/** Does `scope` claim `req`? Every declared scope field must match;
 * an absent scope (or absent field) matches everything. */
export const middlewareScopeMatches = (
	scope: MiddlewareScope | undefined,
	req: MiddlewareRequest,
): boolean => {
	if (scope === undefined) return true;
	if (scope.context !== undefined && scope.context !== req.context) return false;
	if (scope.routeKey !== undefined && scope.routeKey !== req.routeKey) return false;
	if (scope.path !== undefined && !middlewarePathMatches(scope.path, req.path)) return false;
	return true;
};

/** Deterministic stage order: `order` ascending (absent =
 * {@link MIDDLEWARE_ORDER_DEFAULT}), ties by plugin topo order
 * (`pluginIndex`, built-ins at -1 first) then declaration index. */
export const orderMiddlewareEntries = <E extends MiddlewareStageEntry>(
	entries: readonly E[],
): readonly E[] =>
	[...entries].sort(
		(a, b) =>
			(a.order ?? MIDDLEWARE_ORDER_DEFAULT) - (b.order ?? MIDDLEWARE_ORDER_DEFAULT) ||
			a.pluginIndex - b.pluginIndex ||
			a.entryIndex - b.entryIndex,
	);

/** The chain a request would run: ordered entries whose scope claims
 * it. This is what the per-route inspector renders. */
export const effectiveMiddlewareChain = <E extends MiddlewareStageEntry>(
	entries: readonly E[],
	req: MiddlewareRequest,
): readonly E[] =>
	orderMiddlewareEntries(entries).filter((entry) => middlewareScopeMatches(entry.scope, req));

const devWarn = (message: string): void => {
	// import.meta.env is typed structurally (same trick as
	// isProductionBuild in @ktb/app-host): kernel typechecks without a
	// vite dependency and non-Vite runtimes get `undefined`.
	const env = (import.meta as { env?: { DEV?: unknown } }).env;
	/* v8 ignore else -- import.meta.env is per-module: under vitest DEV is
	   always true, so the quiet arm only runs in built bundles. */
	if (env?.DEV === true) {
		// eslint-disable-next-line no-console -- dev-only diagnostic
		console.warn(message);
	}
};

/**
 * Collect every middleware stage across `registry` (topo-ordered —
 * pass `orderPlugins` output) plus the host's built-in stages.
 * Plugin stages ride the dedicated `middleware` field; malformed
 * entries (missing id/handler — e.g. a hand-built fixture) are
 * skipped with a dev warning rather than crashing composition.
 * Built-ins are appended with `pluginIndex: -1` so equal-order ties
 * resolve host-first, and are always collected (they are host
 * infrastructure, not disableable plugins).
 */
export const collectMiddlewareStages = (
	registry: readonly Plugin[],
	builtin: readonly MiddlewareStage[] = [],
): readonly MiddlewareStageEntry[] => {
	const pluginEntries = collectKindContributions(registry, MIDDLEWARE_KIND).flatMap((c) => {
		const stage = c.payload as MiddlewareStage;
		if (
			typeof stage !== "object" ||
			stage === null ||
			typeof stage.id !== "string" ||
			typeof stage.handler !== "function"
		) {
			devWarn(`[middleware] "${c.plugin.id}" contributed a malformed stage — skipped`);
			return [];
		}
		return [
			{
				...stage,
				pluginId: c.plugin.id,
				...(c.plugin.pkg === undefined ? {} : { pkg: c.plugin.pkg }),
				origin: "plugin" as const,
				pluginIndex: c.pluginIndex,
				entryIndex: c.entryIndex,
			},
		];
	});
	const builtinEntries = builtin.map((stage, entryIndex): MiddlewareStageEntry => ({
		...stage,
		pluginId: "app-host",
		origin: "builtin",
		pluginIndex: -1,
		entryIndex,
	}));
	return [...builtinEntries, ...pluginEntries];
};
