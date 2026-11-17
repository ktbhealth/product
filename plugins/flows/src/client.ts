import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). The flows runtime is server-only
 * (DocumentStore, services, Layers never reach the client bundle), so
 * this manifest carries only the bare plugin id: dep edges and
 * enabled-state filtering must line up with the server registry.
 * `flow.def` contributions are JSON data other client surfaces may
 * enumerate via ctx.plugins when a mirror is needed — v1 has no
 * client consumer (no UI/pages ship with the plugin). Keep in sync —
 * parity is asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "flows.services",
		meta: { keywords: ["flows", "services"] },
		requiredDeps: ["document-store.services"],
		// Mirrors flowsServicesPlugin.optionalDeps (server index.ts) —
		// literal id: importing @ktb/rbac-plugin would pull the server
		// graph into the client bundle.
		optionalDeps: ["rbac.services"],
	}),
];
