import { KeyRoundIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { VaultClinicPage } from "./vault-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Server entries keep their ids and
 * dep edges so topo order matches; `pages` keeps id/path/component only
 * — the loader Effect stays server-side in ./index.ts. tables/services
 * degrade to markers. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
const CLINICAL_INSTANCES = ["doctor", "secretary"] as const;

export const vaultPagesPlugin = definePlugin({
	id: "vault.pages",
	requiredDeps: ["vault.services"],
	pages: CLINICAL_INSTANCES.map((instance) => ({
		id: `vault.${instance}`,
		path: `/portal/${instance}/vault`,
		component: VaultClinicPage,
	})),
});

export const vaultChromePlugin = definePlugin({
	id: "vault.chrome",
	chrome: CLINICAL_INSTANCES.map((instance) => ({
		id: `vault.${instance}.nav`,
		region: "portal.sidebar" as const,
		portal: instance,
		content: {
			kind: "sidebarItem" as const,
			item: {
				to: `/portal/${instance}/vault`,
				label: "Vault",
				icon: KeyRoundIcon,
				group: "Clinic",
			},
		},
	})),
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	definePlugin({ id: "vault.tables" }),
	definePlugin({ id: "vault.services" }),
	vaultPagesPlugin,
	vaultChromePlugin,
];
