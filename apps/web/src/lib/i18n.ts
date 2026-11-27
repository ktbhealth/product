import { getRouteApi } from "@tanstack/react-router";
import type { PageI18nSlice } from "@ktb/kernel";
import type { ChromeI18nKeys } from "@ktb/app-host/client";

import { appCatalogT } from "./app-catalog.ts";

/**
 * Host i18n helpers (PL-008 Phase 5 — Paraglide retired). Locale
 * persistence stays the `ktb-locale` cookie; copy resolves from the
 * DB-backed route slice (`app.*` namespace) with the plugin-declared
 * fallback when the slice is absent.
 */

const LOCALE_COOKIE = "ktb-locale";
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

/** The `?locale=` QA override from a raw query string (`location.search`
 * on the client). Returns undefined when absent/empty — callers decide
 * precedence against the cookie/default. */
export function localeFromSearch(search: string): string | undefined {
	const param = new URLSearchParams(search).get("locale");
	return param === null || param === "" ? undefined : param;
}

/** Locale for an incoming request: `?locale=` wins (the QA hook —
 * e.g. `?locale=qps` for the pseudo-locale without touching cookie
 * state), then the `ktb-locale` cookie, then the base locale.
 * Enabled-locale validation happens downstream in
 * `resolveRequestLocales`, so unknown values degrade to default. */
export function requestLocale(request: Request): string {
	return (
		localeFromSearch(new URL(request.url).search) ??
		localeFromCookieHeader(request.headers.get("cookie")) ??
		BASE_LOCALE
	);
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

/**
 * i18n slice for route `head()` functions. The head ctx carries the
 * full `matches` chain (root match first) with each match's resolved
 * `loaderData` — read the ROOT match's slice, which already honors the
 * `?locale=` override the root loader forwards. Leaf routes must NOT
 * run `i18nRouteFn` just to feed `head()`: that would be a second,
 * search-blind server call per navigation. Returns undefined outside a
 * router context (bare unit-test `head()` invocations) so titles fall
 * back to the English baseline.
 */
export const i18nSliceFromHeadMatches = (
	matches: ReadonlyArray<{ routeId?: unknown; loaderData?: unknown }> | undefined,
): PageI18nSlice | undefined => {
	const root = matches?.find((m) => m.routeId === "__root__") ?? matches?.[0];
	return (root?.loaderData as { i18n?: PageI18nSlice } | undefined)?.i18n;
};

/** Endonym for a locale, resolved from the `app.locale_*` messages. */
export function localeName(locale: string, slice?: PageI18nSlice): string {
	return appMessage(slice, `locale_${locale.replaceAll("-", "_")}`, locale);
}

/** Switch the UI locale: persist the cookie, then reload so SSR and
 * the client catalog stay in lockstep (hard-reload requirement). */
export function changeLocale(locale: string): void {
	if (typeof document === "undefined") return;
	document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax; secure`;
	if (typeof window !== "undefined") window.location.reload();
}

/** Localized label for a plugin-declared chrome item (`link` nav entry
 * or `sidebarItem`), or its raw label. The `app.*` message key comes
 * from the contributing plugin's `i18nKeys.labels` (merged by
 * `collectI18nKeys`) — the host keeps no path→key map of its own. */
export function pluginItemLabel(
	to: string,
	fallback: string,
	slice: PageI18nSlice | undefined,
	keys: ChromeI18nKeys,
): string {
	const key = keys.labels[to];
	return key === undefined ? fallback : appMessage(slice, key, fallback);
}

/** Localized label for a plugin-declared sidebar group, or its raw
 * label — key from `i18nKeys.groups`, same contract as item labels. */
export function pluginGroupLabel(
	group: string,
	slice: PageI18nSlice | undefined,
	keys: ChromeI18nKeys,
): string {
	const key = keys.groups[group];
	return key === undefined ? group : appMessage(slice, key, group);
}

/** Localized text for a plugin-declared footer note, or its fallback —
 * key from `i18nKeys.notes`. */
export function pluginFooterNote(
	key: string,
	fallback: string,
	slice: PageI18nSlice | undefined,
	keys: ChromeI18nKeys,
): string {
	const messageKey = keys.notes[key];
	return messageKey === undefined ? fallback : appMessage(slice, messageKey, fallback);
}
