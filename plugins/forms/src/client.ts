import { definePlugin, type Plugin } from "@ktb/kernel";

import { FormsPage } from "./forms-page.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contribution is carried: the page descriptor (id/path/component/
 * context — the loader Effect stays server-side in ./index.ts).
 * Dep ids are literals: importing ./index.ts would pull the server
 * graph into the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const formsPagesPlugin = definePlugin({
	id: "forms.pages",
	meta: { keywords: ["forms", "ui"] },
	pages: [
		{
			id: "forms.form",
			path: "/forms/*",
			context: "app",
			component: FormsPage,
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [formsPagesPlugin];
