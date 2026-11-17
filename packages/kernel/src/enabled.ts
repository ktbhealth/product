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
