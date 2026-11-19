import * as Effect from "effect/Effect";

import { Email } from "@ktb/email";
import { definePlugin, type Plugin } from "@ktb/kernel";

import { patientSignInHead, signInPickerHead } from "./page-head.tsx";
import { LoginPickerPage } from "./views/LoginPickerPage.tsx";
import { PortalSignInPage } from "./views/PortalSignInPage.tsx";

/**
 * Sign-in pages plugin: the public `/login` role picker and the
 * patient sign-in `/login/patient`, migrated from the host file
 * routes (apps/web/src/routes/login.tsx, login-patient.tsx) into
 * `pages` descriptors — app context, no guard (both surfaces are
 * public; anonymous visitors sign in/up). The picker renders whatever
 * `app.login.tiles` chrome is live per P-058 plugin_state; the patient
 * page's loader Effect reports whether this deployment can send email
 * (`Email` resolves to null on the disabled driver) so the sign-up
 * flow can skip the verification step — same signal the auth
 * plugin's emailEnabledFn exposes to its login routes. Post-login
 * audience facts stay client-side (`portalAudiencesFn` +
 * `doctorContextFn`); copy resolves from the `sign-in-page` i18n
 * namespace via PageContext. Mirrors ./client.ts (the
 * client-discovery manifest); parity is asserted by
 * apps/web/src/plugins.test.ts.
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
			loader: () =>
				Effect.map(Effect.service(Email), (sender) => ({
					emailEnabled: sender !== null,
				})),
			head: patientSignInHead,
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [signInPagesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"sign-in-page.pages": true;
	}
}
