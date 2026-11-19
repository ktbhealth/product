import * as Effect from "effect/Effect";

import { Email } from "@ktb/email";
import { definePlugin, type Plugin } from "@ktb/kernel";

import { verifyEmailHead } from "./head.tsx";
import { VerifyEmailPage } from "./views/VerifyEmailPage.tsx";

/**
 * Verify-email page plugin: the public `/verify-email` resend surface,
 * migrated from the host file route (apps/web/src/routes/verify-email.tsx)
 * into a `pages` descriptor — app context, no guard (the page is public;
 * anonymous visitors resend to a typed address). The `loader` Effect
 * reports whether this deployment can send email (`Email` resolves to
 * null on the disabled driver) so the view can swap the form for an
 * unavailable notice — same signal the auth plugin's emailEnabledFn
 * exposes to its login routes. Session facts stay client-side
 * (`authClient.useSession()`); copy resolves from the `verify-email`
 * i18n namespace via PageContext. Mirrors ./client.ts (the
 * client-discovery manifest); parity is asserted by
 * apps/web/src/plugins.test.ts.
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
			loader: () =>
				Effect.map(Effect.service(Email), (sender) => ({
					emailEnabled: sender !== null,
				})),
			head: verifyEmailHead,
		},
	],
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [verifyEmailPagesPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"verify-email.pages": true;
	}
}
