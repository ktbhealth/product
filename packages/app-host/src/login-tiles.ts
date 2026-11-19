import { collectChrome, packageLive, type ChromeContribution, type Plugin } from "@ktb/kernel";

import { enabledIdSet, enabledPlugins, type PluginStatesResult } from "./plugin-state.ts";

/**
 * /login role-picker tiles: each sign-in flow's owning plugin declares a
 * `loginTile` chrome contribution into `app.login.tiles`; this module
 * collects the live ones — the same enabled-set filter every chrome
 * region applies, plus each tile's `requires` gate. It lives in
 * app-host (not the app) so plugin-owned sign-in pages can resolve the
 * same offer set without importing the composition root.
 */

const LOGIN_TILES_REGION = "app.login.tiles";
const LOGIN_PATH = "/login";

/**
 * Whether one `requires` id is live, resolved like `entryEnabled`
 * (packages/kernel/src/enabled.ts): a plugin carrying a `pkg` stamp
 * is live iff its PACKAGE is live (`packageLive` — any member id
 * enabled); an unstamped plugin keeps the per-id check. Unknown ids
 * fail CLOSED — a typo'd requirement must never widen the picker.
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
	states: PluginStatesResult,
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
	states: PluginStatesResult,
): ReadonlySet<string> =>
	new Set(
		visibleLoginTiles(plugins, states).flatMap((entry) =>
			entry.content.kind === "loginTile"
				? [entry.content.to]
				: /* v8 ignore next -- visibleLoginTiles already filters to loginTile entries */ [],
		),
	);
