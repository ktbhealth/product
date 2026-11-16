import { getRouteApi } from "@tanstack/react-router";
import type { PageI18nSlice } from "@ktb/kernel";

import { appCatalogT } from "./app-catalog.ts";

export { appCatalogT } from "./app-catalog.ts";

/**
 * Host i18n helpers (PL-008 Phase 5 — Paraglide retired). Locale
 * persistence stays the `ktb-locale` cookie; copy resolves from the
 * DB-backed route slice (`app.*` namespace) with the plugin-declared
 * fallback when the slice is absent.
 */

export const LOCALE_COOKIE = "ktb-locale";
export const BASE_LOCALE = "en";

/**
 * Extract the locale cookie from a raw `Cookie` header value.
 * Returns undefined when absent; enabled-locale validation happens in
 * `resolveRequestLocales` downstream.
 */
export function localeFromCookieHeader(header: string | null): string | undefined {
	if (!header) return undefined;
	const match = header.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`));
	const value = match?.[1];
	return value === undefined || value === "" ? undefined : value;
}

/** Locale for an incoming request: cookie first, then the base locale. */
export function requestLocale(request: Request): string {
	return localeFromCookieHeader(request.headers.get("cookie")) ?? BASE_LOCALE;
}

/** Catalog lookup for an `app.*` message; the declared fallback wins
 * when even the baseline lacks the key. */
export const appMessage = (
	slice: PageI18nSlice | undefined,
	key: string,
	fallback: string,
): string => {
	const full = `app.${key}`;
	const resolved = appCatalogT(slice)(full);
	return resolved === full ? fallback : resolved;
};

/** Root-loader i18n slice for standalone route components. Returns
 * undefined outside a router context (bare unit-test renders) so copy
 * degrades to the English baseline instead of throwing. */
export const useRootI18nSlice = (): PageI18nSlice | undefined => {
	try {
		return getRouteApi("__root__").useLoaderData().i18n as PageI18nSlice | undefined;
	} catch {
		return undefined;
	}
};

/** Endonym for a locale, resolved from the `app.locale_*` messages. */
export function localeName(locale: string, slice?: PageI18nSlice): string {
	return appMessage(slice, `locale_${locale.replaceAll("-", "_")}`, locale);
}

// Plugin nav labels are declared in plugin manifests (English-only data);
// the host maps known destinations to localized chrome strings here.
const NAV_LABELS: Record<string, string> = {
	"/consultations": "nav_consultations",
	"/patients": "nav_patients",
};

// Same deal for /platform console chrome: sidebar item labels are keyed
// by route path, group headers by their manifest group name.
const PANEL_LABELS: Record<string, string> = {
	"/platform": "panel_nav_dashboard",
	"/platform/consultations": "nav_consultations",
	"/platform/patients": "nav_patients",
	"/platform/users": "panel_nav_users",
	"/platform/groups": "panel_nav_groups",
	"/platform/ops": "panel_nav_ops",
	"/platform/plugins": "panel_nav_plugins",
};

const PANEL_GROUPS: Record<string, string> = {
	Access: "panel_group_access",
	Domains: "panel_group_domains",
	System: "panel_group_system",
};

// Footer notes are plugin-declared keys (English fallback in the
// manifest); the host maps known keys to localized strings here.
const FOOTER_NOTES: Record<string, string> = {
	disclaimer: "footer_disclaimer",
};

/** Switch the UI locale: persist the cookie, then reload so SSR and
 * the client catalog stay in lockstep (hard-reload requirement). */
export function changeLocale(locale: string): void {
	if (typeof document === "undefined") return;
	document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
	if (typeof window !== "undefined") window.location.reload();
}

/** Localized label for a plugin-declared nav item, or its raw label. */
export function pluginNavLabel(to: string, fallback: string, slice?: PageI18nSlice): string {
	const key = NAV_LABELS[to];
	return key === undefined ? fallback : appMessage(slice, key, fallback);
}

/** Localized label for a plugin-declared /platform sidebar item. */
export function pluginPanelLabel(to: string, fallback: string, slice?: PageI18nSlice): string {
	const key = PANEL_LABELS[to];
	return key === undefined ? fallback : appMessage(slice, key, fallback);
}

/** Localized label for a plugin-declared sidebar group, or its raw label. */
export function pluginPanelGroup(group: string, slice?: PageI18nSlice): string {
	const key = PANEL_GROUPS[group];
	return key === undefined ? group : appMessage(slice, key, group);
}

/** Localized text for a plugin-declared footer note, or its fallback. */
export function pluginFooterNote(key: string, fallback: string, slice?: PageI18nSlice): string {
	const messageKey = FOOTER_NOTES[key];
	return messageKey === undefined ? fallback : appMessage(slice, messageKey, fallback);
}
