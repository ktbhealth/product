import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Services and routes degrade to
 * markers; ids are literals so the server graph never reaches the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	// Mirrors patientPortalServicesPlugin.optionalDeps (server index.ts).
	definePlugin({
		id: "patient-portal.services",
		meta: { keywords: ["patient-portal", "services", "patient"] },
		optionalDeps: ["audit.services"],
	}),
	definePlugin({
		id: "patient-portal.routes",
		meta: { keywords: ["patient-portal", "routes", "patient"] },
	}),
];
