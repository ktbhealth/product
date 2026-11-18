import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Both entries degrade to bare-id
 * markers: nothing in this plugin is client-consumed (tables/services
 * never reach the client bundle). Dep ids are literals: importing
 * ./index.ts would pull the server graph (services, Layers) into the
 * client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "api.services",
		meta: { keywords: ["api", "services"] },
		requiredDeps: ["document-store.services"],
	}),
	definePlugin({
		id: "api.routes",
		meta: { keywords: ["api", "routes"] },
		requiredDeps: ["api.services"],
	}),
];
