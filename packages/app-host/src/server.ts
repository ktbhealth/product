import * as Effect from "effect/Effect";

import {
	collectMiddlewareStages,
	entryEnabled,
	effectiveMiddlewareChain,
	middlewareContinue,
	type MiddlewareContext,
	type MiddlewareStage,
	type MiddlewareStageEntry,
	type MiddlewareVerdict,
	type Page,
	type PanelPage,
	type Plugin,
} from "@ktb/kernel";
import { PluginStates } from "@ktb/platform/plugin-states";

import type { PageDataResult } from "./dispatch.ts";
import {
	collectPortals,
	defaultPageContext,
	findPage,
	portalInstanceIdForPath,
	type PageEntry,
	type PageShell,
} from "./pages.ts";

export type { PageDataResult } from "./dispatch.ts";

/**
 * Server-side page dispatch + request-middleware runner (PL-015 /
 * P-110 / P-050 / P-059 / P-081), extracted from the app composition
 * root so any @ktb/app-host consumer gets the same pipeline. The app
 * supplies its runtime (`run`/`runAs`), its registries (server plugin
 * list + the client page maps) and its enabled-id source; everything
 * else — stage ordering, enablement gating, guard/loader merge — is
 * generic host logic.
 */

// ---------- enabled-id cache ----------

/**
 * Short-TTL per-isolate cache for `PluginStates.enabledIds` — the
 * service read is an uncached `plugin_state` select (global rows, no
 * tenant scoping) and EVERY page dispatch resolves it: the middleware
 * enablement gate plus the root loader's pluginStates/i18n fns.
 * Admin toggles are the only writers, so the same staleness trade-off
 * as route caches applies (up to the TTL for an in-flight isolate; no
 * invalidation is wired on the admin write path). Rejections are never
 * cached.
 */
const ENABLED_IDS_TTL_MS = 15_000;

let enabledIdsCache: { readonly at: number; readonly ids: ReadonlySet<string> } | undefined;

/** TTL-cached enabled plugin-id set — see the module doc. */
export const cachedEnabledIds = (
	ttlMs: number = ENABLED_IDS_TTL_MS,
): Effect.Effect<ReadonlySet<string>, never, PluginStates> =>
	Effect.gen(function* () {
		const now = Date.now();
		if (enabledIdsCache !== undefined && now - enabledIdsCache.at < ttlMs) {
			return enabledIdsCache.ids;
		}
		const states = yield* PluginStates;
		const ids = yield* states.enabledIds();
		enabledIdsCache = { at: now, ids };
		return ids;
	});

// ---------- middleware runner ----------

/** Minimal principal shape `runAs` binds (Principal + Tenant inside
 * the per-request effect scope). */
export interface MiddlewareUser {
	readonly id: string;
	readonly email?: string;
	readonly actorId?: string;
}

export type RunEffect = <A, E>(effect: Effect.Effect<A, E, unknown>) => Promise<A>;

export type RunAsEffect = <A, E>(
	user: MiddlewareUser,
	effect: Effect.Effect<A, E, unknown>,
) => Promise<A>;

/** Deps for {@link makePageMiddlewareRunner}: the discovered server
 * registry (stage collection + package-granular enablement), the host
 * built-in stages (composition-root gates plugins cannot contribute),
 * the enabled-id source (usually {@link cachedEnabledIds}) and the
 * app runtime's effect runners. */
export interface PageMiddlewareRunnerDeps {
	readonly plugins: readonly Plugin[];
	readonly builtinStages?: readonly MiddlewareStage[];
	readonly enabledIds: Effect.Effect<ReadonlySet<string>, unknown, unknown>;
	readonly run: RunEffect;
	readonly runAs: RunAsEffect;
}

/**
 * Build the request-middleware runner (PL-015 / P-110): resolves the
 * effective stage chain for a page-dispatch request — host built-ins
 * plus every plugin-contributed `middleware` stage whose scope claims
 * it — and executes them LINEARLY with early return. Each stage runs
 * as an Effect through the app runtime: unbound (`run`) until the
 * principal stage stores `ctx.state.user`, then bound (`runAs`) so
 * Principal + Tenant are in scope for every later stage — the same
 * binding the page guard/loader get afterwards.
 *
 * Enablement: plugin-contributed stages are gated package-granular
 * (P-058) — a disabled plugin's stages are SKIPPED, not denied; the
 * `ktb.plugin.enabled` built-in still owns the page-owner verdict.
 * The predicate is the same `entryEnabled` the MiddlewareStages admin
 * view reports, over the enabled-id set the deps supply. Built-ins
 * always run.
 */
export const makePageMiddlewareRunner = (deps: PageMiddlewareRunnerDeps) => {
	let entries: readonly MiddlewareStageEntry[] | undefined;

	/** Collected chain, memoized — the registry is static per isolate. */
	const allEntries = (): readonly MiddlewareStageEntry[] =>
		(entries ??= collectMiddlewareStages(deps.plugins, deps.builtinStages ?? []));

	const invokeStage = (entry: MiddlewareStageEntry, ctx: MiddlewareContext) => {
		const effect = entry.handler(ctx);
		const user = ctx.state.user;
		// runAs binds Principal + Tenant for the stage; before the
		// principal stage resolves a user (or on public app pages) stages
		// run unbound — services that need a principal fail Forbidden,
		// exactly like the pre-pipeline dispatch.
		return user === null || user === undefined
			? deps.run(effect)
			: deps.runAs(user as MiddlewareUser, effect);
	};

	return async (ctx: MiddlewareContext): Promise<MiddlewareVerdict> => {
		// `ctx.plugins` is the discovered registry the dispatch edge
		// always supplies; absent, pkg-scoped checks fail closed (same
		// contract as the ktb.plugin.enabled stage).
		const plugins = ctx.plugins ?? [];
		// The enabled-id set resolves lazily — at most once per request,
		// and only when a plugin-contributed stage is actually in scope.
		let enabled: ReadonlySet<string> | undefined;
		for (const entry of effectiveMiddlewareChain(allEntries(), ctx)) {
			const gated =
				entry.origin === "plugin" &&
				!entryEnabled(plugins, (enabled ??= await deps.run(deps.enabledIds)), entry);
			if (gated) continue;
			const verdict = await invokeStage(entry, ctx);
			if (verdict.type !== "continue") return verdict;
		}
		return middlewareContinue();
	};
};

// ---------- page dispatch ----------

/** Server-registry page lookup, built lazily on first dispatch — kept
 * out of module scope so registries that must never reach the client
 * bundle stay handler-only. Merges `panel.pages` AND `pages`
 * contributions; first in topo order wins, matching the client
 * registry. */
export const collectServerPages = (
	plugins: readonly Plugin[],
): ReadonlyMap<string, Page | PanelPage> => {
	const map = new Map<string, Page | PanelPage>();
	for (const p of plugins) {
		for (const page of [...(p.panel?.pages ?? []), ...(p.pages ?? [])]) {
			if (!map.has(page.path)) map.set(page.path, page);
		}
	}
	return map;
};

/** What {@link dispatchPage} needs from the app: the server registry
 * (owner ids, server-side guard/loader descriptors, portal instances),
 * the client-registry page maps the route dispatchers resolve against,
 * the effect runners and the middleware pipeline. */
export interface PageDispatchDeps {
	readonly plugins: readonly Plugin[];
	readonly appPages: ReadonlyMap<string, PageEntry>;
	readonly portalPages: ReadonlyMap<string, PageEntry>;
	readonly run: RunEffect;
	readonly runAs: RunAsEffect;
	readonly runMiddleware: (ctx: MiddlewareContext) => Promise<MiddlewareVerdict>;
}

export interface PageDispatchInput {
	readonly path: string;
	readonly shell: PageShell;
	readonly search?: Record<string, unknown>;
}

interface DispatchMemo {
	readonly serverPages: ReadonlyMap<string, Page | PanelPage>;
	readonly portalEntries: ReturnType<typeof collectPortals>;
}

// serverPageMap/serverPortalEntries memoize per deps object — the deps
// are composition-root constants (one per app isolate), so a WeakMap
// keyed on them reproduces the old module-level `let` caches without
// leaking across recomposed test registries.
const dispatchMemo = new WeakMap<PageDispatchDeps, DispatchMemo>();

const memoFor = (deps: PageDispatchDeps): DispatchMemo => {
	let memo = dispatchMemo.get(deps);
	if (memo === undefined) {
		memo = {
			serverPages: collectServerPages(deps.plugins),
			portalEntries: collectPortals(deps.plugins),
		};
		dispatchMemo.set(deps, memo);
	}
	return memo;
};

/** The registry entry for the portal instance `path` belongs to, or
 * undefined for app paths / unregistered instances. */
const portalEntryForPath = (portalEntries: ReturnType<typeof collectPortals>, path: string) =>
	portalEntries.find((e) => e.instance.id === portalInstanceIdForPath(path));

/**
 * Shared page dispatch (P-050/P-059/P-081): resolves the descriptor
 * registered for `input.path` in the shell's page map and runs its
 * Effect handlers. Portal pages require a session AND membership in
 * the path's portal instance audience (anonymous → notfound); app
 * pages may be public — effects then run without a bound Principal
 * (`run` instead of `runAs`), so loaders that need a user must guard
 * themselves. The enabled-state gate applies to both shells at
 * PACKAGE granularity (same contract as the CQRS gate — `plugins/<pkg>`
 * is one deployable unit): a fully disabled package's pages 404
 * exactly like unregistered paths. Page `guard` runs before `loader`;
 * `false` or a failure hides the page. Pages without a loader get
 * `{ status: "ok", data: null }`. `search` is the request's parsed URL
 * search params — forwarded to `loader` as its optional second
 * argument (app pages use it for schema-driven param cleaning); portal
 * dispatch passes none.
 */
export const dispatchPage = async (
	input: PageDispatchInput,
	deps: PageDispatchDeps,
): Promise<PageDataResult> => {
	const { path, shell, search } = input;
	const memo = memoFor(deps);
	// findPage resolves exact paths first, then the longest matching
	// "/*" wildcard subtree — DB-backed pages (pages plugin) register
	// one wildcard descriptor that serves every path its guard/loader
	// resolves.
	const entry = findPage(shell === "portal" ? deps.portalPages : deps.appPages, path);
	if (entry === undefined) return { status: "notfound" };
	// Entries injected by tests may predate the `context` field — derive
	// it from the path the same way collectPages does.
	const context = entry.context ?? defaultPageContext(path);
	if (context !== shell) return { status: "notfound" };
	// Request-middleware pipeline (PL-015/P-110): the former inline
	// gates — principal/session resolution, plugin enablement, portal
	// audience — now run as ordered stages plus any plugin-contributed
	// `middleware` stages, linear with early return. Portal instances
	// may declare `subject: "doctor"` (P-081): the principal stage then
	// resolves the doctor-acting user — `Principal.userId` is the acting
	// doctor's id and `actorId` the signed-in account, exactly like the
	// plugins' own server fns; no doctor profile to act as → deny →
	// notfound, same as anonymous. `deny` maps to notfound; `redirect`
	// short-circuits with a navigation target the route dispatchers turn
	// into a router redirect.
	const portalEntry = shell === "portal" ? portalEntryForPath(memo.portalEntries, path) : undefined;
	const middlewareCtx: MiddlewareContext = {
		path,
		context: shell,
		routeKey: entry.page.path,
		...(search === undefined ? {} : { search }),
		owner: {
			pluginId: entry.pluginId,
			...(entry.pkg === undefined ? {} : { pkg: entry.pkg }),
		},
		subject:
			shell === "portal" && portalEntry?.instance.subject === "doctor" ? "doctor" : "session",
		plugins: deps.plugins,
		...(portalEntry === undefined ? {} : { portalInstance: portalEntry.instance }),
		state: {},
	};
	const verdict = await deps.runMiddleware(middlewareCtx);
	if (verdict.type === "deny") return { status: "notfound" };
	if (verdict.type === "redirect") return { status: "redirect", to: verdict.to };
	// The principal stage stored the resolved user (null on public app
	// pages) — guard/loader run under the same run/runAs split the
	// stages used.
	const user = middlewareCtx.state.user;
	const runEffect = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
		user === null || user === undefined
			? deps.run(effect)
			: deps.runAs(user as MiddlewareUser, effect);
	// Page descriptors are split across the two registries: the client
	// manifest carries id/path/component, while `guard`/`loader` stay
	// server-side on the @ktb/app-host plugin objects and never reach
	// the browser bundle. A descriptor's own handlers win when present —
	// tests inject full pages directly.
	// Look the server descriptor up by the ENTRY's registered path, not
	// the request path: wildcard descriptors ("/*") would otherwise
	// claim every unmatched request and their guard/loader would run
	// for pages they don't own.
	const serverPage = memo.serverPages.get(entry.page.path);
	const page = entry.page;
	const guard = page.guard ?? serverPage?.guard;
	// Widened view of the loader union: `Page.loader` takes an optional
	// search record, `PanelPage.loader` declares path only — both are
	// invoked with `(path, search)`; single-param loaders ignore the
	// extra argument at runtime.
	const loader:
		| ((path: string, search?: Record<string, unknown>) => Effect.Effect<unknown, unknown, unknown>)
		| undefined = page.loader ?? serverPage?.loader;
	// Page-level guard (feature flags / entitlements) runs before the
	// loader; `false` — or a failure — hides the page exactly like an
	// unknown path.
	if (guard !== undefined) {
		const allowed = await runEffect(guard(path)).catch(() => false);
		if (!allowed) return { status: "notfound" };
	}
	if (loader === undefined) return { status: "ok", data: null };
	return { status: "ok", data: await runEffect(loader(path, search)) };
};
