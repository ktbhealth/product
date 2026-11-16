/**
 * Client-side enabled-plugin filtering (P-058). `pluginStatesFn` returns
 * the enabled id set (no `plugin_state` row = enabled); every registry
 * consumer filters through `enabledPlugins` before reading
 * chrome/landing/panel contributions so a disabled plugin renders
 * nothing. Server-side enforcement lives in the page data fns
 * (`portalPageDataFn`/`appPageDataFn` → notfound), the plugin
 * file/api-route gate (`pluginEnabled` capability) and the CQRS
 * dispatch gate in @ktb/app-host.
 *
 * Enable-state SURFACES are package-granular: `plugins/<pkg>` is one
 * deployable unit, live while ANY of its member plugin ids is enabled
 * (`packageLive`/`entryEnabled` — defined in @ktb/kernel so the pure
 * predicates stay dependency-free, re-exported here for the app-host
 * client surface). The `plugin_state` store itself stays per plugin
 * id — the /platform/plugins manager toggles ids individually.
 */

/** Wire shape of `pluginStatesFn`. */
export interface PluginStatesResult {
	readonly enabled: readonly string[];
}

export const enabledIdSet = (states: PluginStatesResult): ReadonlySet<string> =>
	new Set(states.enabled);

/** Plugins whose id is in the enabled set, topo order preserved. */
export const enabledPlugins = <T extends { readonly id: string }>(
	plugins: readonly T[],
	enabled: ReadonlySet<string>,
): T[] => plugins.filter((p) => enabled.has(p.id));

// The package-granular predicates live in @ktb/kernel (pure, no deps)
// so composition roots can use them without pulling the client
// registry; re-exported here so @ktb/app-host/client consumers keep a
// single import surface.
export { entryEnabled, packageLive } from "@ktb/kernel";
export type { PackagedPlugin, PluginEntryRef } from "@ktb/kernel";
