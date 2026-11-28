import { FlaskConicalIcon, Users2Icon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { InstancesPanelPage, PersonasPanelPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client`. Only client-consumed contributions:
 * the two Evaluation-group sidebar entries and serializable panel page
 * descriptors. Guard/loader Effects stay server-side. Parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "eval.persona.tables",
		meta: { keywords: ["eval", "persona", "tables"] },
		// Mirrors evalPersonaTablesPlugin — drizzle schema never reaches
		// the client bundle.
		optionalDeps: ["ai.provider.tables"],
	}),
	definePlugin({
		id: "eval.persona.services",
		meta: { keywords: ["eval", "persona", "services"] },
		// Mirrors evalPersonaServicesPlugin.requiredDeps/optionalDeps —
		// literal ids.
		requiredDeps: ["eval.persona.tables"],
		optionalDeps: ["ai.provider.services"],
	}),
	definePlugin({
		id: "eval.persona.chrome",
		i18nKeys: {
			groups: { Evaluation: "panel_group_evaluation" },
		},
		meta: { keywords: ["eval", "persona", "ui"] },
		requiredDeps: ["platform.panel"],
		chrome: [
			{
				id: "eval-personas.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform/eval/personas",
						label: "1 · Personas",
						icon: Users2Icon,
						group: "Evaluation",
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
						label: "2 · Generate consultations",
						icon: FlaskConicalIcon,
						group: "Evaluation",
					},
				},
			},
		],
	}),
	definePlugin({
		id: "eval.persona.panel",
		meta: { keywords: ["eval", "persona", "ui"] },
		requiredDeps: ["platform.panel", "eval.persona.services"],
		panel: {
			pages: [
				{ id: "eval.persona", path: "/platform/eval/personas", component: PersonasPanelPage },
				{ id: "eval.instance", path: "/platform/eval/instances", component: InstancesPanelPage },
			],
		},
	}),
];
