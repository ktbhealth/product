// Client registry collections (@ktb/app-host/client): the discovered
// plugin list plus everything derived from it — page maps, portal
// instances, chrome helpers and enabled-state filters. Re-exported here
// so routes and server fns keep a single app-bound import path; this
// file is the documented @ktb/app-host exception in vite.config.ts
// (same role #/plugins.ts plays for the raw registry).
export {
	appPages,
	boundaryEntries,
	collectChrome,
	collectPortals,
	defaultPageContext,
	enabledIdSet,
	enabledPlugins,
	findPage,
	findPortalInstance,
	KNOWN_CHROME_REGIONS,
	entryEnabled,
	loginTileTargets,
	namespacesForPath,
	packageLive,
	portalInstances,
	portalInstanceIdForPath,
	portalPages,
	selectErrorBoundary,
	selectNotFoundBoundary,
	visibleLoginTiles,
	warnUnknownChromeRegions,
} from "@ktb/app-host/client";
export type { PageShell, PluginStatesResult } from "@ktb/app-host/client";
