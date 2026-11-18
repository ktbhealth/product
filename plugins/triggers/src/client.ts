import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). The entry degrades to a bare-id
 * marker: nothing in this plugin is client-consumed (services never
 * reach the client bundle). Dep ids are literals: importing
 * ./index.ts would pull the server graph (services, Layers) into the
 * client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "triggers.services",
		meta: { keywords: ["triggers", "services"] },
		requiredDeps: ["document-store.services"],
	}),
];
