import { ClipboardCheckIcon } from "lucide-react";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { EvalValidatorPage } from "./platform-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contributions are carried: the console sidebar entry and the panel
 * page descriptor. `panel.pages` keep id/path/component only — the
 * guard/loader Effects run server-side and stay in ./index.ts. Dep ids
 * are literals: importing ./index.ts would pull the server graph into
 * the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const evalValidatorChromePlugin = definePlugin({
	id: "eval.validator.chrome",
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "eval-validator.sidebar",
			region: "console.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/eval",
					label: "Eval validator",
					icon: ClipboardCheckIcon,
					group: "System",
				},
			},
		},
	],
});

export const evalValidatorPanelPlugin = definePlugin({
	id: "eval.validator.panel",
	requiredDeps: ["platform.panel", "eval.validator.services"],
	panel: {
		pages: [{ id: "eval.validator", path: "/platform/eval", component: EvalValidatorPage }],
	},
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "eval.validator.tables",
		// Mirrors evalValidatorTablesPlugin (server index.ts) minus the
		// tables slice — drizzle schema never reaches the client bundle.
	}),
	definePlugin({
		id: "eval.validator.services",
		// Mirrors evalValidatorServicesPlugin.requiredDeps (server
		// index.ts) — literal ids.
		requiredDeps: ["eval.validator.tables"],
	}),
	evalValidatorChromePlugin,
	evalValidatorPanelPlugin,
	definePlugin({
		id: "eval-validator.routes",
		// Mirrors evalValidatorRoutesPlugin (server index.ts) minus the
		// routes slice — api route paths never reach the client bundle.
	}),
];
