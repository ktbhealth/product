import { UserCogIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { SecretariesPortalPage } from "./views/SecretariesPortalPage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Server entries keep their ids and
 * dep edges so topo order matches; `chrome` is client-consumed and
 * `pages` keep id/path/component only — loader Effects stay
 * server-side in ./index.ts. Tables, services and routes degrade to
 * markers; ids are literals so the server graph never reaches the
 * client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({ id: "secretaries.tables", meta: { keywords: ["secretaries", "tables"] } }),
	definePlugin({ id: "secretaries.services", meta: { keywords: ["secretaries", "services"] } }),
	definePlugin({ id: "secretaries.routes", meta: { keywords: ["secretaries", "routes"] } }),
	definePlugin({
		id: "secretaries.pages",
		meta: { keywords: ["secretaries", "ui", "doctor"] },
		requiredDeps: ["portal.shell"],
		pages: [
			{
				id: "secretaries.manage",
				path: "/portal/doctor/secretaries",
				component: SecretariesPortalPage,
			},
		],
	}),
	definePlugin({
		id: "secretaries.chrome",
		meta: { keywords: ["secretaries", "ui", "doctor"] },
		requiredDeps: ["portal.shell"],
		chrome: [
			{
				id: "secretaries.nav.manage",
				region: "portal.sidebar",
				portal: "doctor",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/portal/doctor/secretaries",
						label: "Secretaries",
						icon: UserCogIcon,
						group: "Account",
					},
				},
			},
		],
	}),
];
