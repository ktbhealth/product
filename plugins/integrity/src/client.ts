import { clientStub, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Both entries degrade to bare-id
 * markers: nothing in this plugin is client-consumed (tables/services
 * never reach the client bundle). Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	clientStub({ id: "integrity.tables", meta: { keywords: ["integrity", "tables"] } }),
	clientStub({ id: "integrity.services", meta: { keywords: ["integrity", "services"] } }),
];
