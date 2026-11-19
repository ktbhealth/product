import { collectChrome, packageLive, type ChromeContribution, type Plugin } from "@ktb/kernel";

/**
 * /login role-picker tiles — LOCAL reimplementation of
 * @ktb/app-host's `visibleLoginTiles`/`loginTileTargets`
 * (packages/app-host/src/login-tiles.ts). Arch lint bans plugins from
 * importing `@ktb/app-host` (IMPL_IMPORT_PATTERNS), so the same gate
 * is reproduced here over @ktb/kernel primitives: each sign-in flow's
 * owning plugin declares a `loginTile` into `app.login.tiles` and this
 * module collects the live ones under the P-058 plugin_state enabled
 * set, honoring each tile's `requires` list.
 *
 * Input contract: `plugins` may be the FULL registry (tests, host
 * callers) or the host's already enabled-filtered `ctx.plugins` —
 * `enabledPlugins` below is idempotent over either. One edge differs
 * from the app-host version on filtered input: a `requires` id that is
 * disabled while its PACKAGE stays live via a sibling member resolves
 * `false` here (the disabled id is absent from `ctx.plugins`, so the
 * pkg-stamped branch can't see it) where app-host resolves `true`.
 * That fails CLOSED — a tile is hidden, never wrongly offered — which
 * is the safe direction for a sign-in picker.
 */

const LOGIN_TILES_REGION = "app.login.tiles";
const LOGIN_PATH = "/login";

/** Wire shape of the host's pluginStates payload — structurally
 * identical to app-host's PluginStatesResult without the import. */
export interface LoginTileStates {
	readonly enabled: readonly string[];
}

const enabledIdSet = (states: LoginTileStates): ReadonlySet<string> => new Set(states.enabled);

/** Plugins whose id is in the enabled set, topo order preserved —
 * same helper app-host's plugin-state.ts carries. */
const enabledPlugins = <T extends { readonly id: string }>(
	plugins: readonly T[],
	enabled: ReadonlySet<string>,
): T[] => plugins.filter((p) => enabled.has(p.id));

/**
 * Whether one `requires` id is live, resolved like app-host's
 * `requiresLive` (packages/kernel/src/enabled.ts `entryEnabled`): a
 * plugin carrying a `pkg` stamp is live iff its PACKAGE is live
 * (`packageLive` — any member id enabled); an unstamped plugin keeps
 * the per-id check. Unknown ids fail CLOSED — a typo'd requirement
 * must never widen the picker.
 */
const requiresLive = (
	plugins: readonly Plugin[],
	enabled: ReadonlySet<string>,
	id: string,
): boolean => {
	const plugin = plugins.find((p) => p.id === id);
	if (plugin === undefined) return false;
	return plugin.pkg === undefined ? enabled.has(id) : packageLive(plugins, enabled, plugin.pkg);
};

/**
 * The `loginTile` contributions visible under `states`, in render
 * order (entry.order, then plugin topo order — collectChrome's
 * contract). A tile renders only when its own plugin is enabled AND
 * every `requires` id is live.
 */
export const visibleLoginTiles = (
	plugins: readonly Plugin[],
	states: LoginTileStates,
): ChromeContribution[] => {
	const enabled = enabledIdSet(states);
	return collectChrome(enabledPlugins(plugins, enabled), LOGIN_TILES_REGION, LOGIN_PATH).filter(
		(entry) =>
			entry.content.kind === "loginTile" &&
			(entry.content.requires ?? []).every((id) => requiresLive(plugins, enabled, id)),
	);
};

/** The `to` paths of the visible tiles — the cross-link check the
 * sign-in pages apply ("is this flow offered?"). */
export const loginTileTargets = (
	plugins: readonly Plugin[],
	states: LoginTileStates,
): ReadonlySet<string> =>
	new Set(
		visibleLoginTiles(plugins, states).map(
			(entry) =>
				(entry.content as Extract<ChromeContribution["content"], { kind: "loginTile" }>).to,
		),
	);
