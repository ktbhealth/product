import type { Plugin } from "@ktb/kernel";

/**
 * Route → i18n namespace derivation (PL-008 Phase 2). Which message
 * namespaces a pathname needs is a pure function of the plugin
 * registry: the page that will render (same exact-then-longest-
 * wildcard rule as the dispatcher) plus every chrome contribution
 * whose `when` matches. Host chrome always needs the `app` namespace.
 *
 * Namespace = the plugin id minus its trailing concern segment
 * (`patients.services` → `patients`, `eval.credentials.panel` →
 * `eval.credentials`); `app` is reserved for host copy. Disabled
 * plugins are filtered by the caller (enabledPlugins) before this runs.
 */

/** Host-owned namespaces always loaded on every shell. */
export const HOST_NAMESPACES: readonly string[] = ["app"];

const namespaceOf = (pluginId: string): string => {
	const parts = pluginId.split(".");
	return parts.length > 1 ? parts.slice(0, -1).join(".") : pluginId;
};

interface PageRef {
	readonly pluginId: string;
	readonly path: string;
}

const pagePaths = (plugin: Plugin): readonly PageRef[] => {
	const refs: PageRef[] = [];
	if ("pages" in plugin && plugin.pages) {
		for (const p of plugin.pages) refs.push({ pluginId: plugin.id, path: p.path });
	}
	if ("panel" in plugin && plugin.panel?.pages) {
		for (const p of plugin.panel.pages) refs.push({ pluginId: plugin.id, path: p.path });
	}
	return refs;
};

/** Does `pattern` (exact path or `prefix/*`) claim `pathname`? The bare
 * prefix itself counts — same rule as chrome `when.paths`. */
const pathClaims = (pattern: string, pathname: string): boolean => {
	if (pattern.endsWith("/*")) {
		const base = pattern.slice(0, -2);
		return pathname === base || pathname.startsWith(`${base}/`);
	}
	return pattern === pathname;
};

/** Chrome `when` visibility: `paths` must match (absent = every page),
 * `exceptPaths` always wins. */
const whenMatches = (
	when:
		| { readonly paths?: readonly string[]; readonly exceptPaths?: readonly string[] }
		| undefined,
	pathname: string,
): boolean => {
	if (!when) return true;
	if (when.exceptPaths?.some((p) => pathClaims(p, pathname))) return false;
	if (!when.paths) return true;
	return when.paths.some((p) => pathClaims(p, pathname));
};

/**
 * Namespaces a request for `pathname` needs, sorted + deduped.
 * `plugins` must already be enabled-state filtered.
 */
export const namespacesForPath = (
	plugins: readonly Plugin[],
	pathname: string,
): readonly string[] => {
	const namespaces = new Set<string>(HOST_NAMESPACES);

	// Winning page: exact path beats wildcard; longest wildcard base
	// wins; ties keep plugin topo order (first seen).
	let winner: PageRef | undefined;
	let winnerScore = -1;
	for (const plugin of plugins) {
		for (const ref of pagePaths(plugin)) {
			if (ref.path === pathname) {
				winner = ref;
				winnerScore = Number.MAX_SAFE_INTEGER;
				break;
			}
			if (ref.path.endsWith("/*") && pathClaims(ref.path, pathname)) {
				const baseLen = ref.path.length;
				if (baseLen > winnerScore) {
					winner = ref;
					winnerScore = baseLen;
				}
			}
		}
		if (winnerScore === Number.MAX_SAFE_INTEGER) break;
	}
	if (winner) namespaces.add(namespaceOf(winner.pluginId));

	// Chrome contributions visible on this path.
	for (const plugin of plugins) {
		if (!("chrome" in plugin) || !plugin.chrome) continue;
		for (const c of plugin.chrome) {
			if (whenMatches(c.when, pathname)) {
				namespaces.add(namespaceOf(plugin.id));
				break;
			}
		}
	}

	// Router boundaries render outside the page winner (404 replaces it,
	// error can replace any page) — their copy must be in the slice for
	// every path, enabled plugins only (caller already filtered).
	for (const plugin of plugins) {
		if ("boundaries" in plugin && plugin.boundaries !== undefined && plugin.boundaries.length > 0) {
			namespaces.add(namespaceOf(plugin.id));
		}
	}

	return [...namespaces].sort();
};

/** Every namespace the registry can produce — the panel's root list. */
export const allNamespaces = (plugins: readonly Plugin[]): readonly string[] => {
	const namespaces = new Set<string>(HOST_NAMESPACES);
	for (const plugin of plugins) {
		if (plugin.id) namespaces.add(namespaceOf(plugin.id));
	}
	return [...namespaces].sort();
};
