import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Both server entries degrade to
 * bare-id markers: tables/services are server-only contributions with
 * no browser consumer, but the ids and topo position must match so the
 * client registry mirrors the server registry. Keep in sync — parity
 * is asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({ id: "integrity.tables" }),
	definePlugin({ id: "integrity.services" }),
];
