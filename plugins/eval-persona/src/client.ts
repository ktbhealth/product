import { FlaskConicalIcon, Users2Icon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { InstancesPanelPage, PersonasPanelPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the two Eval-group sidebar entries and serializable panel page
 * descriptors. Guard/loader Effects stay server-side. Parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "eval.persona.tables",
		// Mirrors evalPersonaTablesPlugin — drizzle schema never reaches
		// the client bundle.
		requiredDeps: ["eval.validator.tables"],
	}),
	definePlugin({
		id: "eval.persona.services",
		// Mirrors evalPersonaServicesPlugin.requiredDeps/optionalDeps —
		// literal ids.
		requiredDeps: ["eval.persona.tables"],
		optionalDeps: ["eval.credentials.services"],
	}),
	definePlugin({
		id: "eval.persona.chrome",
		requiredDeps: ["platform.panel"],
		chrome: [
			{
				id: "eval-personas.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/eval/personas",
						label: "Personas",
						icon: Users2Icon,
						group: "Eval",
					},
				},
			},
			{
				id: "eval-instances.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/eval/instances",
						label: "Instances",
						icon: FlaskConicalIcon,
						group: "Eval",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "eval.persona.panel",
		requiredDeps: ["platform.panel", "eval.persona.services"],
		panel: {
			pages: [
				{ id: "eval.persona", path: "/platform/eval/personas", component: PersonasPanelPage },
				{ id: "eval.instance", path: "/platform/eval/instances", component: InstancesPanelPage },
			],
		},
	}),
];
