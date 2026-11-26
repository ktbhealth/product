import { WorkflowIcon } from "lucide-react";

import { clientStub, definePlugin, type Plugin } from "@ktb/kernel";

import { OrchestrationEditorPanelPage, PipelinesAdminPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). pipeline.core stays a bare-id
 * marker (data-only manifest). The admin plugins keep id/dep edges and
 * the client-consumed contributions — the portal.sidebar chrome entry
 * and the panel page descriptors (id/path/component only; loaders stay
 * server-side in ./index.ts). Dep ids are literals: importing
 * ./index.ts would pull the server graph into the client bundle. Keep
 * in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const pipelineAdminChromePlugin = definePlugin({
	id: "pipeline.admin.chrome",
	requiredDeps: ["platform.panel"],
	meta: {
		keywords: ["platform", "ui", "admin"],
		name: "Pipelines",
		description: "Orchestration def administration",
		icon: WorkflowIcon,
	},
	chrome: [
		{
			id: "pipeline.admin.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/pipelines",
					label: "Pipelines",
					icon: WorkflowIcon,
					group: "Runtime",
				},
			},
		},
	],
});

export const pipelineAdminPanelPlugin = definePlugin({
	id: "pipeline.admin.panel",
	requiredDeps: ["platform.panel"],
	meta: {
		keywords: ["platform", "ui", "admin"],
		name: "Pipelines",
		description: "Orchestration def administration",
		icon: WorkflowIcon,
	},
	panel: {
		pages: [
			{
				id: "pipeline.admin.list",
				path: "/platform/pipelines",
				component: PipelinesAdminPage,
			},
			{
				id: "pipeline.admin.editor",
				path: "/platform/pipelines/*",
				component: OrchestrationEditorPanelPage,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	clientStub({
		id: "pipeline.core",
		meta: {
			name: "Pipeline",
			description:
				"Pipeline engine composition — collects pipeline packs contributed by plugin manifests into the shared PipelineRegistry.",
			keywords: ["platform", "services"],
		},
	}),
	pipelineAdminChromePlugin,
	pipelineAdminPanelPlugin,
];
