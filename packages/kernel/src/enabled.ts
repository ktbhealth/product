/**
 * Package-granular enable-state predicates (P-058). The `plugin_state`
 * store is per plugin id, but every enable-state SURFACE — page
 * dispatch, plugin file/api routes, CQRS groups — treats
 * `plugins/<pkg>` as one deployable unit: live while ANY member plugin
 * id is enabled. Membership resolves through the `pkg` stamp
 * `discoverPlugins` (@ktb/driver-framework) puts on each plugin —
 * plugin ids are NOT reliably namespaced (`auth` ships `session.menu`,
 * `transcription-asr` ships `transcription.asr`), so an id-prefix
 * guess would misjudge packages. These helpers are pure so server
 * (PluginStates.enabledIds) and client (pluginStatesFn) gates share
 * one contract.
 */

import type { Plugin } from "./contributions.ts";

/** The minimal plugin shape the predicates need — satisfied by both
 * the server and client registry entries. */
export interface PackagedPlugin {
	readonly id: string;
	readonly pkg?: string;
}

/** A registry entry carrying its owning plugin id (and pkg stamp when
 * present) — PageEntry/PortalInstanceEntry in @ktb/app-host satisfy
 * this structurally. */
export interface PluginEntryRef {
	readonly pluginId: string;
	readonly pkg?: string;
}

/** Whether package `pkg` is live: any member plugin id in `enabled`. */
export const packageLive = (
	plugins: readonly PackagedPlugin[],
	enabled: ReadonlySet<string>,
	pkg: string,
): boolean => {
	for (const p of plugins) {
		if (p.pkg === pkg && enabled.has(p.id)) return true;
	}
	return false;
};

/** Enabled-state gate for a registry entry: package-granular when the
 * owner carries a `pkg` stamp, per-id otherwise — out-of-glob plugins
 * (@ktb/platform) and hand-built entries have none. */
export const entryEnabled = <E extends PluginEntryRef>(
	plugins: readonly PackagedPlugin[],
	enabled: ReadonlySet<string>,
	entry: E,
): boolean =>
	entry.pkg === undefined ? enabled.has(entry.pluginId) : packageLive(plugins, enabled, entry.pkg);

/**
 * Owner→enablement index built from the plugin registry at composition
 * time — shared by every `*.def`-style registry that stamps `owner`
 * (trigger/view/api-exposure/flow/wizard/form defs). Enablement itself
 * is RUNTIME state (`PluginStates`, DB-backed): defs stay static
 * composition data and each service re-checks `def.owner` against
 * `PluginStates.enabledIds()` per request/dispatch, so a
 * /platform/plugins toggle takes effect without a layer rebuild (same
 * contract as the CQRS dispatch gate in @ktb/app-host).
 */
export interface DefOwnerIndex {
	/** plugin id → `pkg` stamp (`undefined` when the plugin carries none). */
	readonly pkgById: ReadonlyMap<string, string | undefined>;
	/** pkg → member plugin ids — packageLive needs the whole member set. */
	readonly membersByPkg: ReadonlyMap<string, readonly string[]>;
}

/** Build the index a `make*Definitions` attaches to its registry. */
export const buildDefOwnerIndex = (plugins: readonly Plugin[]): DefOwnerIndex => {
	const pkgById = new Map<string, string | undefined>();
	const membersByPkg = new Map<string, string[]>();
	for (const plugin of plugins) {
		pkgById.set(plugin.id, plugin.pkg);
		if (plugin.pkg !== undefined) {
			const members = membersByPkg.get(plugin.pkg) ?? [];
			members.push(plugin.id);
			membersByPkg.set(plugin.pkg, members);
		}
	}
	return { pkgById, membersByPkg };
};

/**
 * Package-granular enablement for a def `owner` — mirrors
 * `entryEnabled`/`packageLive` above: a pkg-stamped owner is live
 * while ANY package member id is enabled; an unstamped or unindexed
 * owner falls back to the per-id check. `owner`/`index` absent →
 * `true`: unattributed defs (hand-built registries) cannot be gated
 * and stay live.
 */
export const defOwnerEnabled = (
	index: DefOwnerIndex | undefined,
	owner: string | undefined,
	enabled: ReadonlySet<string>,
): boolean => {
	if (owner === undefined) return true;
	if (index === undefined || !index.pkgById.has(owner)) return enabled.has(owner);
	const pkg = index.pkgById.get(owner);
	if (pkg === undefined) return enabled.has(owner);
	return (index.membersByPkg.get(pkg) ?? [owner]).some((id) => enabled.has(id));
};
