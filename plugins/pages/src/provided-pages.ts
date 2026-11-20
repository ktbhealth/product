import { entryEnabled, type Plugin } from "@ktb/kernel";

/**
 * Inventory of plugin-contributed pages for the /platform/pages console
 * (P-104): the table lists `pages` DB rows AND every page
 * descriptor plugins ship via `pages`/`panel.pages`, tagged with the
 * owning plugin id. This mirrors `collectPages` in @ktb/app-host —
 * plugins cannot import app-host (the client registry glob would
 * cycle), so the same topo-order/dedupe/contract rules are applied
 * here over `ctx.plugins`. Keep the semantics in sync: first claim in
 * topo order wins, app-context pages on portal-routed paths and
 * portal-context pages outside portal instances are skipped.
 */

export interface ProvidedPageRef {
	/** Descriptor id (e.g. "audit.admin") — shown as the row's title. */
	readonly pageId: string;
	/** Declared path — may be a wildcard ("/forms/*", "/*"). */
	readonly path: string;
	/** Id of the plugin that contributed the descriptor. */
	readonly pluginId: string;
	readonly context: "app" | "portal";
}

const PLATFORM_ROOT = "/platform";
const PORTAL_ROOT = "/portal";

const portalInstanceIds = (plugins: readonly Plugin[]): ReadonlySet<string> => {
	const ids = new Set<string>();
	for (const plugin of plugins) {
		if ("portals" in plugin && plugin.portals) {
			for (const instance of plugin.portals) ids.add(instance.id);
		}
	}
	return ids;
};

const portalRouted = (path: string, instanceIds: ReadonlySet<string>): boolean => {
	if (path === PLATFORM_ROOT || path.startsWith(`${PLATFORM_ROOT}/`)) return true;
	if (!path.startsWith(`${PORTAL_ROOT}/`) || path.length <= PORTAL_ROOT.length + 1) {
		return false;
	}
	// split("/") always yields at least one element — the ?? only
	// satisfies noUncheckedIndexedAccess.
	/* v8 ignore next */
	return instanceIds.has(path.slice(PORTAL_ROOT.length + 1).split("/")[0] ?? "");
};

/**
 * Every reachable page descriptor across `plugins`, deduped by path
 * (first contributor in topo order wins — `ctx.plugins` arrives
 * topo-sorted). `enabled` is the runtime enable-state set
 * (`ctx.pluginStates.enabled`); package-granular via `entryEnabled`,
 * same gate the dispatchers apply. Absent `enabled` lists everything
 * (hosts without plugin-state wiring).
 */
export const collectProvidedPages = (
	plugins: readonly Plugin[],
	enabled?: ReadonlySet<string>,
): readonly ProvidedPageRef[] => {
	const instanceIds = portalInstanceIds(plugins);
	// Dedupe runs over the FULL registry like collectPages — a disabled
	// plugin earlier in topo order still shadows later claims on the
	// same path (dispatch 404s on the winner's enable gate), so the
	// enabled filter applies to winners only, after the fact.
	const byPath = new Map<string, ProvidedPageRef & { readonly pkg?: string }>();
	const add = (plugin: Plugin, pageId: string, path: string, context: "app" | "portal") => {
		if (byPath.has(path)) return;
		byPath.set(path, {
			pageId,
			path,
			pluginId: plugin.id,
			...(plugin.pkg === undefined ? {} : { pkg: plugin.pkg }),
			context,
		});
	};
	for (const plugin of plugins) {
		// panel.pages are portal pages by definition (P-050).
		if ("panel" in plugin && plugin.panel?.pages) {
			for (const page of plugin.panel.pages) add(plugin, page.id, page.path, "portal");
		}
		if ("pages" in plugin && plugin.pages) {
			for (const page of plugin.pages) {
				const context = page.context ?? (portalRouted(page.path, instanceIds) ? "portal" : "app");
				// Same contract drops as collectPages: an app-context page
				// on a portal-routed path (or vice versa) never dispatches.
				if (context === "app" && portalRouted(page.path, instanceIds)) continue;
				if (context === "portal" && !portalRouted(page.path, instanceIds)) continue;
				add(plugin, page.id, page.path, context);
			}
		}
	}
	return [...byPath.values()]
		.filter(
			(ref) =>
				enabled === undefined ||
				entryEnabled(plugins, enabled, { pluginId: ref.pluginId, pkg: ref.pkg }),
		)
		.map(({ pkg: _pkg, ...ref }) => ref)
		.sort((a, b) => a.path.localeCompare(b.path));
};
