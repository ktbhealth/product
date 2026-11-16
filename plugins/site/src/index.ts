import { definePlugin, type Plugin } from "@ktb/kernel";

import { SiteLocaleToggle } from "./chrome.tsx";

/**
 * Site chrome plugin (P-060): the app-shell regions owned by @ktb/site —
 * locale toggle and the footer disclaimer note. The brand block moved
 * to the theme plugin in PL-006 phase 7 (brand lives in theme data).
 * Mirrors ./client.ts (the client-discovery manifest); parity is
 * asserted by apps/web/src/plugins.test.ts.
 */
export const siteChromePlugin = definePlugin({
	id: "site.chrome",
	chrome: [
		{
			id: "site.locale",
			region: "app.header.actions",
			content: { kind: "component", component: SiteLocaleToggle },
		},
		{
			id: "site.footer-note",
			region: "app.footer.note",
			content: {
				kind: "note",
				key: "disclaimer",
				fallback:
					"KTB is a documentation tool: the physician holds total decision. The anamnesis is a draft and must be reviewed by the responsible physician.",
			},
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [siteChromePlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"site.chrome": true;
	}
}
