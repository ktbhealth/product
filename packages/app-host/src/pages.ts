import type { Page, Plugin, PortalInstance } from "@ktb/kernel";

/**
 * Unified page registry (P-059/P-081): every page a plugin contributes —
 * `panel.pages` portal descriptors AND generic `pages` entries — keyed
 * by absolute path, split by the shell that dispatches them. "portal"
 * pages live under a portal instance (/platform, /portal/<id>) behind
 * the audience gate and render portal chrome; "app" pages render inside
 * the marketing shell via the root splat route and may be public.
 * `panel.pages` entries count as context "portal" on the platform
 * instance.
 *
 * The registry is computed by the caller (`collectPages`) — this module
 * stays registry-agnostic so any plugin list can be merged; the client
 * entry (`./client.ts`) runs it once over the discovered `plugins`.
 */

/** Which host shell owns a page: a portal instance or the app
 * marketing shell. */
export type PageShell = "app" | "portal";

/** A page descriptor plus the id of the plugin that owns it — the
 * enabled-state gate (`*PageDataFn`) and the route dispatchers need
 * the owner id, which the bare page object doesn't carry. */
export interface PageEntry {
	readonly page: Page;
	readonly pluginId: string;
	/** Deployable package (`plugins/<pkg>`) owning `pluginId`, stamped
	 * by discoverPlugins — the enabled-state gate checks the whole
	 * package, not just this id. Undefined for out-of-glob plugins
	 * (e.g. @ktb/platform) and test-injected entries → per-id check. */
	readonly pkg?: string;
	readonly context?: PageShell;
}

export interface PageRegistry {
	/** Every contributed page by path — first contributor in topo
	 * order wins; later duplicates are dropped with a dev warning. */
	readonly pages: ReadonlyMap<string, PageEntry>;
	/** App-shell pages only — the root `/$` splat dispatches through
	 * this map. */
	readonly appPages: ReadonlyMap<string, PageEntry>;
	/** Portal pages only — the /platform index/`$` routes and the
	 * /portal/$instance splat dispatch through this map (exported as
	 * `portalPages`). */
	readonly portalPages: ReadonlyMap<string, PageEntry>;
}

const PLATFORM_ROOT = "/platform";
const PORTAL_ROOT = "/portal";

/** /platform and anything beneath it belongs to the platform portal
 * instance; /portal/<segment>/… belongs to the namespaced instance
 * named by that segment (bare /portal stays app — the patient portal
 * owns it). */
export const isPortalPath = (path: string): boolean => {
	if (path === PLATFORM_ROOT || path.startsWith(`${PLATFORM_ROOT}/`)) return true;
	return path.startsWith(`${PORTAL_ROOT}/`) && path.length > PORTAL_ROOT.length + 1;
};

/** The portal instance id a path dispatches to: "platform" under
 * /platform*, the first segment under /portal/<id>/…, undefined for
 * app paths. */
export const portalInstanceIdForPath = (path: string): string | undefined => {
	if (path === PLATFORM_ROOT || path.startsWith(`${PLATFORM_ROOT}/`)) return "platform";
	if (!path.startsWith(`${PORTAL_ROOT}/`) || path.length <= PORTAL_ROOT.length + 1) {
		return undefined;
	}
	return path.slice(PORTAL_ROOT.length + 1).split("/")[0];
};

/** Context derived from the path when the descriptor doesn't declare
 * one: portal-instance paths → portal, everything else → app. */
export const defaultPageContext = (path: string): PageShell =>
	isPortalPath(path) ? "portal" : "app";

const devWarn = (message: string): void => {
	if (import.meta.env.DEV) {
		// eslint-disable-next-line no-console -- dev-only diagnostic
		console.warn(message);
	}
};

/**
 * Merge every page contribution of `registry` into path-keyed maps.
 * Iteration order is the plugin topo order, so the FIRST plugin to
 * claim a path wins; duplicates are skipped with a dev warning (the
 * kernel contract asks plugins for unique paths — this is the
 * runtime backstop, same role `orderPlugins` plays for dep edges).
 * An app-context page claiming a portal-routed path is a contract
 * violation: warned and ignored. A portal-context page outside
 * portal-routed paths is warned and ignored too — no dispatcher
 * reaches it.
 *
 * "Portal-routed" is instance-aware (route collapse): `/platform*`
 * always routes to the console, but `/portal/<id>…` only dispatches
 * to a portal shell when `<id>` is a contributed instance — the root
 * splat falls unknown ids through to app pages, so plugins may own
 * paths like "/portal/login" (legacy redirects) as app context.
 */
export const collectPages = (registry: readonly Plugin[]): PageRegistry => {
	const pages = new Map<string, PageEntry>();
	const appPages = new Map<string, PageEntry>();
	const portalPages = new Map<string, PageEntry>();
	const instanceIds = new Set(collectPortals(registry).map((e) => e.instance.id));
	const portalRouted = (path: string): boolean => {
		if (path === PLATFORM_ROOT || path.startsWith(`${PLATFORM_ROOT}/`)) return true;
		const id = portalInstanceIdForPath(path);
		return id !== undefined && instanceIds.has(id);
	};
	const add = (plugin: Plugin, page: Page, context: PageShell) => {
		if (pages.has(page.path)) {
			devWarn(
				`[pages] path "${page.path}" claimed by both "${pages.get(page.path)?.pluginId}" ` +
					`and "${plugin.id}" — first in topo order wins`,
			);
			return;
		}
		const entry: PageEntry = {
			page,
			pluginId: plugin.id,
			...(plugin.pkg === undefined ? {} : { pkg: plugin.pkg }),
			context,
		};
		pages.set(page.path, entry);
		(context === "app" ? appPages : portalPages).set(page.path, entry);
	};
	for (const plugin of registry) {
		// panel.pages are portal pages by definition (P-050) — they all
		// live under /platform today, the platform instance.
		for (const page of plugin.panel?.pages ?? []) add(plugin, page, "portal");
		for (const page of plugin.pages ?? []) {
			const context = page.context ?? (portalRouted(page.path) ? "portal" : "app");
			if (context === "app" && portalRouted(page.path)) {
				devWarn(
					`[pages] "${plugin.id}" claims portal path "${page.path}" as app context — ignored`,
				);
				continue;
			}
			if (context === "portal" && !portalRouted(page.path)) {
				devWarn(
					`[pages] "${plugin.id}" marks "${page.path}" as portal but it is not under a portal instance — ignored`,
				);
				continue;
			}
			add(plugin, page, context);
		}
	}
	return { pages, appPages, portalPages };
};

/**
 * Resolve the page entry for a request path: exact-path descriptors win;
 * failing that, wildcard entries — keys ending in "/*" (same syntax as
 * chrome `when` paths) whose base prefixes `path` — are considered, and
 * the LONGEST matching base wins. Ties keep the first entry in map
 * (topo) order. This is what lets a single DB-backed descriptor (e.g.
 * the pages plugin's "/*") serve every path it resolves.
 */
export const findPage = <V>(map: ReadonlyMap<string, V>, path: string): V | undefined => {
	const exact = map.get(path);
	if (exact !== undefined) return exact;
	let best: V | undefined;
	let bestBase = -1;
	for (const [key, entry] of map) {
		if (!key.endsWith("/*")) continue;
		const base = key.slice(0, -2);
		const matches =
			base === "" ? path.startsWith("/") : path === base || path.startsWith(`${base}/`);
		if (matches && base.length > bestBase) {
			best = entry;
			bestBase = base.length;
		}
	}
	return best;
};

/** A contributed portal instance plus the id of the plugin that owns
 * it — the enabled-state gate needs the owner id. */
export interface PortalInstanceEntry {
	readonly instance: PortalInstance;
	readonly pluginId: string;
	/** Same package stamp as `PageEntry.pkg` — the instance's enable
	 * gate is package-granular too. */
	readonly pkg?: string;
}

/** Every portal instance contributed by `registry`, in topo order. */
export const collectPortals = (registry: readonly Plugin[]): readonly PortalInstanceEntry[] =>
	registry.flatMap((plugin) =>
		(plugin.portals ?? []).map((instance) => ({
			instance,
			pluginId: plugin.id,
			...(plugin.pkg === undefined ? {} : { pkg: plugin.pkg }),
		})),
	);

/** The instance entry for `id`, or undefined when no plugin declares
 * it — the route dispatchers 404 on undefined. */
export const findPortalInstance = (
	entries: readonly PortalInstanceEntry[],
	id: string,
): PortalInstanceEntry | undefined => entries.find((e) => e.instance.id === id);
