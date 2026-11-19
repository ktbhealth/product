import { definePlugin, type Plugin } from "@ktb/kernel";

import { verifyEmailHead } from "./head.tsx";
import { VerifyEmailPage } from "./views/VerifyEmailPage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Carries the client-consumed page
 * fields only: id/path/component/context plus the isomorphic `head`
 * hook (same function reference as the server manifest — the parity
 * test compares it). The `loader` Effect stays server-side in
 * ./index.ts and must never reach the client bundle. Keep in sync —
 * parity is asserted by apps/web/src/plugins.test.ts.
 */
export const verifyEmailPagesPlugin = definePlugin({
	id: "verify-email.pages",
	meta: { keywords: ["auth", "ui"] },
	pages: [
		{
			id: "verify-email.page",
			path: "/verify-email",
			context: "app",
			component: VerifyEmailPage,
			head: verifyEmailHead,
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [verifyEmailPagesPlugin];
