import { createServerFn } from "@tanstack/react-start";

import { Email } from "@ktb/email";
import { Notifications, rowToConsole } from "@ktb/notifications";
import { run, runAs, serverPlugins } from "#/lib/platform.ts";
import { Db, type DbClient } from "@ktb/db";
import {
	GLOBAL_SCOPE,
	PSEUDO_LOCALE,
	portalInstanceScope,
	portalScope,
	resolveRequestLocales,
	tenantScope,
} from "@ktb/i18n";
import { catalogSlice, DEFAULT_LOCALE, listEnabledLocales, stableSlice } from "@ktb/i18n-plugin";
import { currentLocale } from "./locale-context.ts";
import { localeFromSearch } from "./i18n.ts";
import {
	appPages,
	portalPages,
	collectPortals,
	defaultPageContext,
	enabledIdSet,
	enabledPlugins,
	findPage,
	findPortalInstance,
	namespacesForPath,
	portalInstanceIdForPath,
	portalInstances,
	type PageShell,
	type PluginStatesResult,
} from "#/lib/registry.ts";
import { PortalAudience, PORTAL_AUDIENCE } from "@ktb/portal";
import { TenantResolver, tenantSelectorFromHeaders, tenantScopeId } from "@ktb/tenant";
import { PlatformAdmin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";
import type { Page, PanelPage } from "@ktb/kernel";
import { Schema } from "effect";
import { ensureDoctorUser, getDoctorUser, getSessionAccount, getSessionUser } from "#/lib/auth.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Services enforce authorization and fail `Forbidden`; handlers translate
// denial into the same "not visible" response as a missing entity
// (null / { ok: false } / 404) via Effect.catchTag — other errors still
// propagate, no data leaks, no error boundary for stale links.

export const getSessionUserFn = createServerFn({ method: "GET" }).handler(() => getSessionUser());

/** Root-layout session: the user plus whether the account is
 * patient-only (no doctor profile to act as), which narrows the
 * navigation to the patient portal. */
export const sessionFn = createServerFn({ method: "GET" }).handler(async () => {
	const account = await getSessionAccount();
	if (account === null) return null;
	// Mirrors the /platform route gate exactly — the session menu shows
	// the console entry iff the gate would let the account through.
	// When the gate becomes permission-driven this flag follows.
	const platformAdmin = await run(
		Effect.flatMap(PlatformAdmin, (admin) => admin.isAdmin(account.email)),
	);
	return { ...account, platformAdmin };
});

/**
 * True when this deployment can send email (an Email driver other than
 * the disabled one is bound). Lets the UI skip flows that would promise
 * a message that is never sent — e.g. the post-sign-up verification step.
 */
export const emailEnabledFn = createServerFn({ method: "GET" }).handler(() =>
	run(Effect.map(Effect.service(Email), (sender) => sender !== null)),
);

/**
 * Enabled plugin ids for chrome/landing/panel filtering (P-058). No row
 * in `plugin_state` means enabled, so the set covers every discovered
 * plugin minus the disabled ones. Unauthenticated — chrome renders for
 * anonymous visitors too. The id universe comes from the service's
 * registry snapshot (serverPlugins and the client registry share ids).
 */
export const pluginStatesFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<PluginStatesResult> => {
		// TTL-cached (ROUTE_CACHE_TTL_MS): plugin_state rows are global and
		// only admin toggles change them — see cachedEnabledIds.
		const enabled = await run(cachedEnabledIds());
		return { enabled: [...enabled] };
	},
);

/**
 * Route-scoped i18n payload (PL-008 Phase 2): which namespaces the
 * pathname needs (derived from the server registry — page winner +
 * visible chrome, same rules as the dispatcher) plus the resolved
 * catalog slice for the request's locale chain. Loader data carries
 * this to the client; `t()` there is a pure lookup — no second
 * roundtrip. The scope chain resolves portal instance → tenant →
 * global from the request path + tenant headers (PL-008 Phase 6).
 */
export interface I18nRouteResult {
	readonly locale: string;
	readonly locales: readonly string[];
	readonly enabledLocales: readonly string[];
	readonly namespaces: readonly string[];
	readonly catalog: Record<string, string>;
}

/**
 * Safe degradation for the root-loader i18n payload: EVERY route runs
 * this fn, so any resolution failure (i18n migration not yet applied,
 * D1 error, registry problem) must not 500 the page. The empty
 * base-locale slice lets copy fall back to English baselines
 * downstream; the failure is logged, not swallowed.
 */
const EMPTY_I18N_ROUTE: I18nRouteResult = {
	locale: DEFAULT_LOCALE,
	locales: [DEFAULT_LOCALE],
	enabledLocales: [DEFAULT_LOCALE],
	namespaces: [],
	catalog: {},
};

/**
 * Short-TTL per-isolate caches for reads that only change via admin
 * actions — matches the plugins/i18n STAMP_TTL_MS convention (15s). An
 * admin locale/plugin toggle can take up to the TTL to reach an
 * in-flight isolate; accepted trade-off (no invalidation is wired on
 * the admin write path). Rejections are never cached. catalogSlice
 * deliberately stays per-navigation (see plugins/i18n slice.ts).
 */
const ROUTE_CACHE_TTL_MS = 15_000;

type EnabledLocaleRows = Awaited<ReturnType<typeof listEnabledLocales>>;

let enabledLocalesCache: { readonly at: number; readonly rows: EnabledLocaleRows } | undefined;

/** `i18n_locales` is global (not tenant-scoped) and only admin locale
 * toggles change it — cache the enabled set per isolate. */
const cachedListEnabledLocales = (db: DbClient): Promise<EnabledLocaleRows> => {
	const now = Date.now();
	if (enabledLocalesCache !== undefined && now - enabledLocalesCache.at < ROUTE_CACHE_TTL_MS) {
		return Promise.resolve(enabledLocalesCache.rows);
	}
	return listEnabledLocales(db).then((rows) => {
		enabledLocalesCache = { at: Date.now(), rows };
		return rows;
	});
};

let enabledIdsCache: { readonly at: number; readonly ids: ReadonlySet<string> } | undefined;

/** `PluginStates.enabledIds` is uncached upstream (a `plugin_state`
 * select per call, and plugin_states rows are global) — share the same
 * TTL cache so the root loader's pluginStatesFn + i18nRouteFn don't
 * each pay a query per navigation. Plugin enable toggles are admin
 * actions; same staleness trade-off as the locale list. */
const cachedEnabledIds = (): Effect.Effect<ReadonlySet<string>, never, PluginStates> =>
	Effect.gen(function* () {
		const now = Date.now();
		if (enabledIdsCache !== undefined && now - enabledIdsCache.at < ROUTE_CACHE_TTL_MS) {
			return enabledIdsCache.ids;
		}
		const states = yield* PluginStates;
		const ids = yield* states.enabledIds();
		enabledIdsCache = { at: now, ids };
		return ids;
	});

export const i18nRouteFn = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		Schema.decodeUnknownSync(
			Schema.Union([
				Schema.String,
				Schema.Struct({
					pathname: Schema.String,
					search: Schema.optionalKey(Schema.String),
				}),
			]),
		)(input),
	)
	.handler(async ({ data: input }): Promise<I18nRouteResult> => {
		// Callers may pass a bare pathname or { pathname, search } — the
		// search carries the page's `?locale=` QA override, which the
		// server-fn RPC request URL would otherwise lose on client-side
		// navigation (the ALS locale only sees the RPC request's own URL).
		const pathname = typeof input === "string" ? input : input.pathname;
		const search = typeof input === "string" ? undefined : input.search;
		return run(
			Effect.gen(function* () {
				// TTL-cached — this fn runs on EVERY navigation.
				const enabled = yield* cachedEnabledIds();
				const database = yield* Db;
				const visible = enabledPlugins(serverPlugins, enabledIdSet({ enabled: [...enabled] }));
				const namespaces = namespacesForPath(visible, pathname);
				const enabledLocales = yield* Effect.promise(() => cachedListEnabledLocales(database));
				const portalId = portalInstanceIdForPath(pathname);
				const instanceId = portalId === "platform" ? undefined : portalId;
				// Portal scope + pinned locale (PL-008 Phase 6): /portal/<id>
				// paths resolve portal-scoped copy, and an instance that
				// declares `locale` overrides the visitor's cookie locale.
				// "/platform" is the console shell, not a portal instance.
				// The instance must actually resolve in the registry —
				// otherwise an arbitrary /portal/<seg> would let anonymous
				// callers probe portal-scoped rows (scope gating, L2).
				const instance =
					instanceId === undefined ? undefined : findPortalInstance(portalInstances, instanceId);
				const pinned = instance?.instance.locale;
				// Page `?locale=` (passed by the loader) wins over the
				// ALS/cookie locale on client-side navigations; portal
				// pinned locale still wins over both.
				const requested =
					pinned ??
					(search === undefined ? undefined : localeFromSearch(search)) ??
					currentLocale();
				const locales = resolveRequestLocales(requested, enabledLocales, DEFAULT_LOCALE);
				// Tenant scope binding (PL-008 Phase 6): same selector +
				// resolver pipeline runAs uses — tenant headers + session
				// account → TenantResolver → scope chain. Anonymous/
				// selector-less requests stay global; portal paths add the
				// tenant slot between portal and global when one resolves.
				const headers = yield* Effect.promise(() =>
					import("@tanstack/react-start/server")
						.then((m) => m.getRequestHeaders())
						.catch(() => new Headers()),
				);
				const selector = tenantSelectorFromHeaders(headers);
				// No tenant headers → personal scope; skip the session
				// lookup so anonymous/app requests pay nothing extra.
				const tenant =
					selector === null
						? null
						: yield* Effect.gen(function* () {
								const account = yield* Effect.promise(() => getSessionAccount().catch(() => null));
								const resolver = yield* TenantResolver;
								return yield* resolver
									.resolve(selector, account?.id ?? null)
									.pipe(Effect.catch(() => Effect.succeed(null)));
							});
				const tenantId = tenant === null ? null : tenantScopeId(tenant);
				const scopeChain =
					instance !== undefined
						? tenantId !== null
							? portalScope(String(tenantId), instance.instance.id)
							: portalInstanceScope(instance.instance.id)
						: tenantId !== null
							? tenantScope(String(tenantId))
							: GLOBAL_SCOPE;
				const catalog = yield* catalogSlice(database, {
					namespaces,
					scopeChain,
					locales,
				});
				return {
					locale: locales.locales[0] ?? DEFAULT_LOCALE,
					locales: locales.locales,
					enabledLocales: enabledLocales.filter((l) => l.code !== PSEUDO_LOCALE).map((l) => l.code),
					namespaces: [...namespaces],
					catalog: stableSlice(catalog),
				};
			}).pipe(
				// Failure isolation (H3): this fn feeds the root loader on
				// every route — degrade to the empty base-locale slice on
				// ANY failure (failures AND defects) instead of 500ing.
				Effect.catchCause((cause) =>
					Effect.logWarning("i18nRouteFn resolution failed; serving base-locale fallback", {
						pathname,
						cause: Cause.pretty(cause),
					}).pipe(Effect.as(EMPTY_I18N_ROUTE)),
				),
			),
		);
	});

/**
 * /platform console gate: true when the session user's email is in the
 * `PLATFORM_ADMIN_EMAILS` allowlist. Non-admins get `false` — route
 * guards turn that into a hard 404; admin data paths enforce the same
 * gate again inside domain services (defense in depth).
 */
export const platformAdminFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await getSessionUser();
	if (!user) return false;
	return run(
		Effect.gen(function* () {
			const platformAdmin = yield* PlatformAdmin;
			return yield* platformAdmin.isAdmin(user.email);
		}),
	);
});

/**
 * Result of the page data server fns (`portalPageDataFn`,
 * `appPageDataFn`): a discriminated union so the route loader can tell
 * "page denied/missing" apart from a loader that legitimately returned
 * `null`/`undefined` data. Server-fn errors do not round-trip as
 * router `notFound()`, so denial is data, not a throw — the route maps
 * `notfound` to `throw notFound()`.
 */
export type PageDataResult =
	| { readonly status: "ok"; readonly data: any }
	| { readonly status: "notfound" };

/** Server-registry page lookup, built lazily on first dispatch — kept
 * out of module scope so the client bundle never evaluates it (the
 * `serverPlugins` import is handler-only, like `run`/`runAs`). Merges
 * `panel.pages` AND `pages` contributions (P-059); first in topo order
 * wins, matching the client registry. */
let serverPages: ReadonlyMap<string, Page | PanelPage> | undefined;

const serverPageMap = (): ReadonlyMap<string, Page | PanelPage> => {
	serverPages ??= (() => {
		const map = new Map<string, Page | PanelPage>();
		for (const p of serverPlugins) {
			for (const page of [...(p.panel?.pages ?? []), ...(p.pages ?? [])]) {
				if (!map.has(page.path)) map.set(page.path, page);
			}
		}
		return map;
	})();
	return serverPages;
};

/** Server-registry portal instances (P-081), built lazily like
 * `serverPageMap` — the audience gate resolves each path's instance
 * descriptor (its `audience` rule) from the server registry. */
let serverPortals: ReturnType<typeof collectPortals> | undefined;

const serverPortalEntries = () => {
	serverPortals ??= collectPortals(serverPlugins);
	return serverPortals;
};

/** The registry entry for the portal instance `path` belongs to, or
 * undefined for app paths / unregistered instances. */
const portalEntryForPath = (path: string) =>
	serverPortalEntries().find((e) => e.instance.id === portalInstanceIdForPath(path));

/**
 * Audience gate for portal pages (P-081): the path's instance
 * (`portalInstanceIdForPath`) must exist in the server registry and
 * the bound principal must satisfy its `audience` rule (absent rule =
 * `member`). Anonymous principals satisfy nothing → notfound. When the
 * portal services plugin is absent the check is skipped — page `guard`s
 * and service authz still apply (test/dev compositions).
 */
const portalAudienceAllows = async (
	path: string,
	runEffect: <A, E>(effect: Effect.Effect<A, E, unknown>) => Promise<A>,
): Promise<boolean> => {
	const entry = portalEntryForPath(path);
	if (entry === undefined) return false;
	const rule = entry.instance.audience ?? PORTAL_AUDIENCE.member;
	return runEffect(
		Effect.gen(function* () {
			const audience = yield* Effect.serviceOption(PortalAudience);
			if (Option.isNone(audience)) return true;
			const set = yield* audience.value.audiences();
			return set.has(rule);
		}),
	).catch(() => false);
};

/**
 * Shared page dispatch (P-050/P-059/P-081): resolves the descriptor
 * registered for `path` in the given shell's client registry and runs
 * its Effect handlers. Portal pages require a session AND membership
 * in the path's portal instance audience (anonymous → notfound);
 * app pages may be public — effects then run without a bound Principal
 * (`run` instead of `runAs`), so loaders that need a user must guard
 * themselves. The enabled-state gate (`PluginStates.isEnabled`) applies
 * to both shells: a disabled plugin's pages 404 exactly like
 * unregistered paths. Page `guard` runs before `loader`; `false` or a
 * failure hides the page. Pages without a loader get
 * `{ status: "ok", data: null }`.
 */
const pageData = async (path: string, shell: PageShell): Promise<PageDataResult> => {
	// findPage resolves exact paths first, then the longest matching
	// "/*" wildcard subtree — DB-backed pages (custom-pages plugin)
	// register one wildcard descriptor that serves every path its
	// guard/loader resolves.
	const entry = findPage(shell === "portal" ? portalPages : appPages, path);
	if (entry === undefined) return { status: "notfound" };
	// Entries injected by tests may predate the `context` field — derive
	// it from the path the same way collectPages does.
	const context = entry.context ?? defaultPageContext(path);
	if (context !== shell) return { status: "notfound" };
	// Portal instances may declare `subject: "doctor"` (P-081): their
	// pages are owner-scoped clinical surfaces, so loaders/guards run
	// under the doctor-resolved acting user — `Principal.userId` is the
	// acting doctor's id and `actorId` the signed-in account, exactly
	// like the plugins' own server fns. No doctor profile to act as →
	// notfound, same as anonymous.
	const user =
		shell === "portal" && portalEntryForPath(path)?.instance.subject === "doctor"
			? await getDoctorUser()
			: await getSessionUser();
	if (shell === "portal" && user === null) return { status: "notfound" };
	const runEffect = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
		user === null ? run(effect) : runAs(user, effect);
	// Enabled-state gate (P-058): checked before guard/loader.
	const pluginOn = await runEffect(
		Effect.gen(function* () {
			const states = yield* PluginStates;
			return yield* states.isEnabled(entry.pluginId);
		}),
	);
	if (!pluginOn) return { status: "notfound" };
	// Portal audience gate (P-081): the instance's `audience` rule must
	// be satisfied by the bound principal — the UX gate; hard authz
	// stays inside the page's services.
	if (shell === "portal" && !(await portalAudienceAllows(path, runEffect))) {
		return { status: "notfound" };
	}
	// Page descriptors are split across the two registries: the client
	// manifest carries id/path/component, while `guard`/`loader` stay
	// server-side on the @ktb/app-host plugin objects and never reach
	// the browser bundle. A descriptor's own handlers win when present —
	// tests inject full pages directly.
	// Look the server descriptor up by the ENTRY's registered path, not
	// the request path: wildcard descriptors ("/*") would otherwise
	// claim every unmatched request and their guard/loader would run
	// for pages they don't own.
	const serverPage = serverPageMap().get(entry.page.path);
	const page = entry.page;
	const guard = page.guard ?? serverPage?.guard;
	const loader = page.loader ?? serverPage?.loader;
	// Page-level guard (feature flags / entitlements) runs before the
	// loader; `false` — or a failure — hides the page exactly like an
	// unknown path.
	if (guard !== undefined) {
		const allowed = await runEffect(guard(path)).catch(() => false);
		if (!allowed) return { status: "notfound" };
	}
	if (loader === undefined) return { status: "ok", data: null };
	return { status: "ok", data: await runEffect(loader(path)) };
};

/**
 * Loader data for /platform console pages (P-050): `panel.pages`
 * descriptors plus console-context `pages` entries. Anonymous callers,
 * unknown paths and `guard` denials all collapse to
 * `{ status: "notfound" }` — the route dispatcher turns that into a 404.
 *
 * NOTE: each export must be a literal `createServerFn` chain — the
 * Start compiler only treats those as server fns; wrapping the chain
 * in a factory (`pageDataFn("portal")`) ships the handler (and its
 * `platform.ts` imports) to the client bundle.
 */
export const portalPageDataFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => Schema.decodeUnknownSync(Schema.String)(input))
	// Loader results are plugin-defined `unknown` at the kernel
	// boundary; the wire type is whatever each page's loader returns
	// (serializable rows — same shape the retired per-page fns sent).
	.handler(async ({ data: path }): Promise<PageDataResult> => pageData(path, "portal"));

/**
 * Audience rule ids the session user satisfies (P-081) — feeds the
 * portal shells' instance switcher and any chrome that varies by
 * audience. Anonymous callers get an empty list. Sorted for stable
 * wire output.
 */
export const portalAudiencesFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<readonly string[]> => {
		const user = await getSessionUser();
		if (user === null) return [];
		return runAs(
			user,
			Effect.gen(function* () {
				const audience = yield* Effect.serviceOption(PortalAudience);
				if (Option.isNone(audience)) return [] as string[];
				return [...(yield* audience.value.audiences())].sort();
			}),
		);
	},
);

/**
 * Console page paths whose `guard` DENIES the session user — the
 * sidebar hides entries pointing at them instead of showing a menu of
 * pages that all 404. Runs each console page's guard once per load
 * (each guard is a permissions lookup — cheap); failures count as
 * denied, same contract as `pageData`. Pages without a guard are
 * never listed: nothing to hide.
 */
export const consoleDeniedFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await getSessionUser();
	if (user === null) return [] as string[];
	const denied: string[] = [];
	for (const entry of portalPages.values()) {
		const path = entry.page.path;
		const guard = entry.page.guard ?? serverPageMap().get(path)?.guard;
		if (guard === undefined) continue;
		const allowed = await runAs(user, guard(path)).catch(() => false);
		if (!allowed) denied.push(path);
	}
	return denied;
});

/**
 * Loader data for app-shell pages contributed via `pages` (P-059):
 * same dispatch as `portalPageDataFn` but session-optional — public
 * pages run their Effects without a bound Principal.
 */
export const appPageDataFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => Schema.decodeUnknownSync(Schema.String)(input))
	.handler(async ({ data: path }): Promise<PageDataResult> => pageData(path, "app"));

// ---------- patients ----------
// Patient server functions are owned by the patients plugin (P-033) —
// its route modules and this host file share the same implementations
// through @ktb/patients/fns. Re-exported here so existing host callers
// (tests) keep their import path.
export {
	adminCreatePatientFn,
	createPatientFn,
	deletePatientFn,
	getPatientFn,
	listPatientsFn,
	patientConsultationsFn as listPatientConsultationsFn,
	patientDeletionImpactFn,
	updatePatientFn,
} from "@ktb/patients/fns";

// ---------- consultations ----------
// Consultation server functions are owned by the consultations plugin —
// its route modules (plugins/consultations/src/routes/**) and this host
// file share the same implementations through @ktb/consultations/fns.
// Re-exported here so existing host callers (tests, /platform routes)
// keep their import path.
export {
	adminCreateConsultationFn,
	adminDeleteConsultationFn,
	adminListAudioJobsFn,
	attachAnamnesisFn,
	extractAnamnesisFn,
	getConsultationFn,
	getLiveConsultationFn,
	listConsultationsFn,
	patientHistoryFn,
	recordConsentFn,
	saveConsultationFn,
	verifyConsultationIntegrityFn,
} from "@ktb/consultations/fns";

// ---------- plugin manager (P-058) ----------
// Plugin-state server functions are owned by the manager plugin — its
// /platform/plugins page imports them from @ktb/manager/fns directly.
// `pluginStatesFn` above stays host-side: the root loader needs it even
// when the manager plugin itself is disabled.

// ---------- notifications ----------

/**
 * The session user's recent console notifications, mapped to the
 * serializable ConsoleNotification shape — seeds NotificationsDataContext
 * on /platform before the SSE feed takes over. Only called when the
 * notifications.services plugin is registered (the service tag is absent
 * otherwise).
 */
export const listMyNotificationsFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await getDoctorUser();
	if (!user) return [];
	return runAs(
		user,
		Effect.gen(function* () {
			const notifications = yield* Notifications;
			const rows = yield* notifications.list(user.id, 50);
			return rows.map(rowToConsole);
		}),
	);
});

/** Exact unread count for the /platform dashboard card — the list fn
 * above is capped at 50 rows, so it can't be derived client-side. */
export const countMyUnreadNotificationsFn = createServerFn({ method: "GET" }).handler(async () => {
	const user = await getDoctorUser();
	if (!user) return 0;
	return runAs(
		user,
		Effect.gen(function* () {
			const notifications = yield* Notifications;
			return yield* notifications.unreadCount(user.id);
		}),
	);
});

const decodeNotificationIds = Schema.decodeUnknownSync(Schema.Array(Schema.Number));

/** Mark specific notifications read — ids are the numeric row ids
 * behind ConsoleNotification.id. Missing/foreign ids are ignored by
 * the service's user-scoped UPDATE. */
export const markMyNotificationsReadFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeNotificationIds(input))
	.handler(async ({ data: ids }) => {
		const user = await ensureDoctorUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const notifications = yield* Notifications;
				return yield* notifications.markRead(user.id, ids).pipe(
					Effect.as(true),
					Effect.catchTag("Forbidden", () => Effect.succeed(false)),
				);
			}),
		);
	});

export const markAllMyNotificationsReadFn = createServerFn({ method: "POST" }).handler(async () => {
	const user = await ensureDoctorUser();
	return runAs(
		user,
		Effect.gen(function* () {
			const notifications = yield* Notifications;
			return yield* notifications.markAllRead(user.id).pipe(
				Effect.as(true),
				Effect.catchTag("Forbidden", () => Effect.succeed(false)),
			);
		}),
	);
});
