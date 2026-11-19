import { definePlugin, type Plugin } from "@ktb/kernel";

import { CaptureTestPage, devCaptureTestBeforeLoad } from "./capture-test-page.tsx";

/**
 * Client-safe plugin entry — discovered by the browser bundle through
 * `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the client-consumed
 * contribution is carried: the page descriptor's id/path/component/
 * context plus the isomorphic `beforeLoad` dev gate (it must run on
 * client navigations too, so it stays here). The server-only `guard`
 * Effect and the `effect` import stay in ./index.ts — dep ids are
 * literals for the same reason. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const devCaptureTestPagesPlugin = definePlugin({
	id: "dev-capture-test.pages",
	meta: {
		name: "Dev capture test",
		description: "Dev-only spike: proves tab audio is capturable via getDisplayMedia.",
		keywords: ["pages", "ui"],
	},
	pages: [
		{
			id: "dev-capture-test.capture",
			path: "/capture-test",
			context: "app",
			component: CaptureTestPage,
			beforeLoad: devCaptureTestBeforeLoad,
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [devCaptureTestPagesPlugin];
