import { KeyRoundIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { CredentialsPanelPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the Eval-group sidebar entry and the serializable panel page
 * descriptor. Guard/loader Effects stay server-side. Parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "eval.credentials.services",
		// Mirrors evalCredentialsServicesPlugin — the ApiKeys port has
		// no registry dep; requiredDeps is empty on the server side too.
		requiredDeps: [],
	}),
	definePlugin({
		id: "eval.credentials.chrome",
		requiredDeps: ["platform.panel"],
		chrome: [
			{
				id: "eval-credentials.sidebar",
				region: "console.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/eval/credentials",
						label: "Credentials",
						icon: KeyRoundIcon,
						group: "Eval",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "eval.credentials.panel",
		requiredDeps: ["platform.panel", "eval.credentials.services"],
		panel: {
			pages: [
				{
					id: "eval.credentials",
					path: "/platform/eval/credentials",
					component: CredentialsPanelPage,
				},
			],
		},
	}),
];

export type { CredentialCard } from "./index.ts";
