import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Tables, services and routes degrade to markers; ids are
 * literals so the server graph never reaches the client bundle. Keep
 * in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({ id: "doctors.tables", meta: { keywords: ["doctors", "tables"] } }),
	definePlugin({ id: "doctors.services", meta: { keywords: ["doctors", "services"] } }),
	definePlugin({ id: "doctors.routes", meta: { keywords: ["doctors", "routes"] } }),
];
