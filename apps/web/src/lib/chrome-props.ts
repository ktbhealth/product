import type { ChromeProps, Plugin } from "@ktb/kernel";
import type { ResolvedTheme } from "@ktb/theme/types";

import { changeLocale, localeName } from "#/lib/i18n.ts";

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
 * `locales`/`localeName` derive from the route's i18n slice (PL-008):
 * enabled locale codes plus endonyms resolved from `app.locale_*`.
 */
export const portalChromeProps = (
	user: ChromeProps["user"],
	locale: string,
	plugins: readonly Plugin[],
	signOut: () => Promise<void>,
	theme?: ResolvedTheme | null,
	i18n?: ChromeProps["i18n"],
	locales?: readonly string[],
): ChromeProps => ({
	user,
	locale,
	i18n,
	plugins,
	locales: locales ?? i18n?.enabledLocales ?? ["en"],
	localeName: (l: string) => localeName(l, i18n),
	setLocale: changeLocale,
	labels: {},
	signOut,
	// Resolved theme for brand chrome (PL-006 phase 7) — same injection
	// the app shell gives `app.header.brand` components.
	theme: theme ?? null,
});
