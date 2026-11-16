import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Server entries keep their ids and dep
 * edges so topo order matches the server registry; the vault's
 * tables/services degrade to markers since all contributions are
 * server-side. Parity is asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({ id: "vault.tables" }),
	definePlugin({ id: "vault.services" }),
];
