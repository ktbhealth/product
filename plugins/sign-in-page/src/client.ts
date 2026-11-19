import { definePlugin, type Plugin } from "@ktb/kernel";

import { patientSignInHead, signInPickerHead } from "./page-head.tsx";
import { LoginPickerPage } from "./views/LoginPickerPage.tsx";
import { PortalSignInPage } from "./views/PortalSignInPage.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Carries the client-consumed page
 * fields only: id/path/component/context plus the isomorphic `head`
 * hooks (same function references as the server manifest — the parity
 * test compares them). The patient page's `loader` Effect stays
 * server-side in ./index.ts and must never reach the client bundle.
 * Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const signInPagesPlugin = definePlugin({
	id: "sign-in-page.pages",
	meta: { keywords: ["auth", "patient", "ui"] },
	pages: [
		{
			id: "sign-in-page.picker",
			path: "/login",
			context: "app",
			component: LoginPickerPage,
			head: signInPickerHead,
		},
		{
			id: "sign-in-page.patient",
			path: "/login/patient",
			context: "app",
			component: PortalSignInPage,
			head: patientSignInHead,
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [signInPagesPlugin];
