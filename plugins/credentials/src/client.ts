import { KeyRoundIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { CredentialsPanelPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the AI-group sidebar entry and the serializable panel page
 * descriptor. Guard/loader Effects stay server-side. Parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "credentials.services",
		meta: { keywords: ["eval", "credentials", "services"] },
		// Mirrors credentialsServicesPlugin — the ApiKeys port has
		// no registry dep; requiredDeps is empty on the server side too.
		// Vault user-scope secrets are the canonical store (P-098 C3).
		requiredDeps: [],
		optionalDeps: ["vault.secrets"],
	}),
	definePlugin({
		id: "credentials.chrome",
		meta: { keywords: ["eval", "credentials", "ui"] },
		requiredDeps: ["platform.panel"],
		chrome: [
			{
				id: "credentials.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/ai/credentials",
						label: "Credentials",
						icon: KeyRoundIcon,
						group: "AI",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "credentials.panel",
		meta: { keywords: ["eval", "credentials", "ui"] },
		requiredDeps: ["platform.panel", "credentials.services"],
		panel: {
			pages: [
				{
					id: "credentials",
					path: "/platform/ai/credentials",
					component: CredentialsPanelPage,
				},
			],
		},
	}),
];

export type { CredentialCard } from "./index.ts";
