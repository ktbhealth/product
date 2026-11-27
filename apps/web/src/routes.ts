import { physical, rootRoute, route } from "@tanstack/virtual-file-routes";

import { routePlugins } from "./lib/route-plugins.ts";

// Host-composed route tree: host-owned routes plus each plugin's declared
// subtree. Self-contained plugins (patients, consultations) contribute
// physical() mounts of their own src/routes directories and reach the app
// runtime through @ktb/server-fns; plugins that still wire host server
// functions keep route modules under src/routes/**.
//
// routePlugins is the static-import list in lib/route-plugins.ts — kept out
// of this file so the drift guard test can import it under vitest without
// pulling in @tanstack/virtual-file-routes. Composition still runs under
// jiti during typegen, where import.meta.glob (used by @ktb/app-host
// plugin discovery) is unavailable — hence static imports, not `plugins`.
export const routes = rootRoute("__root.tsx", [
	...routePlugins.flatMap((p) => p.routes ?? []),
	physical("/api", "api"),
	// Root splat (route collapse): the single plugin-page dispatcher —
	// "/" renders the landing picker, "/platform*" the console shell,
	// "/portal/<instance>/*" the namespaced portal shell, and any other
	// path an app-shell page descriptor. /portal/login lives on as a
	// sign-in-page descriptor (legacy redirect). Static routes above
	// keep match priority.
	route("$", "$.tsx"),
]);
