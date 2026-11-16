import type { ChromeProps, Plugin } from "@ktb/kernel";

import { changeLocale, localeName } from "#/lib/i18n.ts";
import { locales } from "#/paraglide/runtime.js";

/**
 * ChromeProps factory for portal shells (P-082): `portal.brand`
 * contributions are `component` chrome entries that need the full
 * host-injected context (locale, user, labels, sign-out). Plugins may
 * not import the host's i18n/auth, so the route builds the payload
 * once and hands it to every brand component.
 *
 * `labels` stays empty — chrome components fall back to their own
 * English literals per documented key. `signOut` is injected by the
 * route (it already owns the auth-client call for PortalShell).
 */
export const portalChromeProps = (
	user: ChromeProps["user"],
	locale: string,
	plugins: readonly Plugin[],
	signOut: () => Promise<void>,
): ChromeProps => ({
	user,
	locale,
	plugins,
	locales,
	localeName,
	setLocale: changeLocale,
	labels: {},
	signOut,
});
