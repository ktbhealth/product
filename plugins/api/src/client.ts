import { clientStub, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). The api runtime is server-only
 * (HttpApi routes, service Layers never reach the client bundle), so
 * this manifest carries only the bare plugin ids: dep edges and
 * enabled-state filtering must line up with the server registry.
 * `api.exposure` contributions are JSON data client surfaces may
 * enumerate via ctx.plugins when a mirror is needed — v1 has no
 * client consumer. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	clientStub({
		id: "api.services",
		meta: { keywords: ["api", "services"] },
		requiredDeps: ["document-store.services"],
		// Mirrors apiServicesPlugin.optionalDeps (server index.ts) —
		// literal id: importing @ktb/rbac-plugin would pull the server
		// graph into the client bundle.
		optionalDeps: ["rbac.services"],
	}),
	clientStub({
		id: "api.routes",
		meta: { keywords: ["api", "routes"] },
		requiredDeps: ["api.services"],
	}),
];
