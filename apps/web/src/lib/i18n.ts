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

// Plugin nav labels are declared in plugin manifests (English-only data);
// the host maps known destinations to localized chrome strings here.
const NAV_LABELS: Record<string, string> = {
	"/consultations": "nav_consultations",
	"/patients": "nav_patients",
};

// Same deal for /platform console chrome: sidebar item labels are keyed
// by route path, group headers by their manifest group name. Portal
// sidebars share the map — the clinical Account items point at the
// in-portal pages under each instance's base path.
const PANEL_LABELS: Record<string, string> = {
	"/platform": "panel_nav_dashboard",
	"/platform/consultations": "nav_consultations",
	"/platform/patients": "nav_patients",
	"/platform/users": "panel_nav_users",
	"/platform/groups": "panel_nav_groups",
	"/platform/ops": "panel_nav_ops",
	"/platform/plugins": "panel_nav_plugins",
	"/platform/queue": "panel_nav_queue",
	"/platform/cron": "panel_nav_cron",
	"/platform/pubsub": "panel_nav_pubsub",
	"/platform/rich-text": "panel_nav_rich_text",
	"/platform/schemas": "panel_nav_schemas",
	"/portal/doctor/activity": "panel_nav_activity",
	"/portal/secretary/activity": "panel_nav_activity",
	"/portal/doctor/switch-doctor": "nav_switch_doctor",
	"/portal/secretary/switch-doctor": "nav_switch_doctor",
	"/portal/doctor/secretaries": "nav_secretaries",
};

const PANEL_GROUPS: Record<string, string> = {
	Account: "panel_group_account",
	Assurance: "panel_group_assurance",
	Concurrency: "panel_group_concurrency",
	Console: "panel_group_console",
	"Domain data": "panel_group_domain_data",
	Evaluation: "panel_group_evaluation",
	// Clinical portals still group the activity feed under "Governance"
	// (plugins/clinician) — the key stays even though /platform no
	// longer uses it.
	Governance: "panel_group_governance",
	Identity: "panel_group_identity",
	Intelligence: "panel_group_intelligence",
	Presentation: "panel_group_presentation",
	Runtime: "panel_group_runtime",
	Site: "panel_group_site",
	Storage: "panel_group_storage",
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
	document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax; secure`;
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
