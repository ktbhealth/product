import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). The triggers runtime is server-only
 * (EventBus, DocumentStore, service Layers never reach the client
 * bundle), so this manifest carries only the bare plugin id: dep edges
 * and enabled-state filtering must line up with the server registry.
 * `trigger.def` contributions are JSON data other client surfaces may
 * enumerate via ctx.plugins when a mirror is needed — v1 has no
 * client consumer. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "triggers.services",
		meta: { keywords: ["triggers", "services"] },
		requiredDeps: ["document-store.services"],
	}),
];
