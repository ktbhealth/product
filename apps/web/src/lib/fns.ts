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
	enabledIdSet,
	enabledPlugins,
	findPortalInstance,
	namespacesForPath,
	portalInstanceIdForPath,
	portalInstances,
	type PageShell,
	type PluginStatesResult,
} from "#/lib/registry.ts";
import { PortalAudience } from "@ktb/portal";
import {
	TENANT_ROLE_RANK,
	Tenant,
	TenantResolver,
	tenantSelectorFromHeaders,
	tenantScopeId,
} from "@ktb/tenant";
import { PlatformAdmin } from "@ktb/platform";
import {
	doctorHandler,
	forbiddenTo,
	optionalDoctorHandler,
	optionalSessionHandler,
} from "@ktb/server-fns";
import type { Page, PanelPage } from "@ktb/kernel";
import {
	collectServerPages,
	dispatchPage,
	type PageDataResult,
	type PageDispatchDeps,
} from "@ktb/app-host/server";
import { cachedEnabledIds } from "./enabled-ids.ts";
import { runPageMiddleware } from "./middleware.ts";
import { Schema } from "effect";
import { getSessionAccount, getSessionUser } from "#/lib/auth.ts";
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
		Effect.flatMap(PlatformAdmin, (admin) =>
			admin.isAdmin({ email: account.email, userId: account.id }),
		),
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
 * /platform console gate: true when the session user satisfies the
 * `PlatformAdmin` gate — email allowlist or RBAC admin grant. Non-admins
 * get `false` — route
 * guards turn that into a hard 404; admin data paths enforce the same
 * gate again inside domain services (defense in depth).
 */
export const platformAdminFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => false,
		async ({ user }) =>
			run(
				Effect.gen(function* () {
					const platformAdmin = yield* PlatformAdmin;
					// Subject form: RBAC-granted superadmins pass alongside the
					// email allowlist — userId is the signed-in account id.
					return yield* platformAdmin.isAdmin({ email: user.email, userId: user.id });
				}),
			),
	),
);

/**
 * Result of the page data server fns (`portalPageDataFn`,
 * `appPageDataFn`) — the wire contract lives in @ktb/app-host
 * (`PageDataResult`); re-exported for existing importers.
 */
export type { PageDataResult };

/** Server-registry page lookup for `consoleDeniedFn` guard checks —
 * the dispatch itself lives in @ktb/app-host/server (`dispatchPage`);
 * this memo feeds only the sidebar's denied-path scan. */
let serverPages: ReadonlyMap<string, Page | PanelPage> | undefined;

const serverPageMap = (): ReadonlyMap<string, Page | PanelPage> => {
	serverPages ??= collectServerPages(serverPlugins);
	return serverPages;
};

/** App-bound dispatch deps: the discovered server registry, the
 * client-registry page maps, the runtime runners and the middleware
 * pipeline (lib/middleware.ts binds @ktb/app-host/server's generic
 * runner to this app's stages/env). */
const pageDispatchDeps: PageDispatchDeps = {
	plugins: serverPlugins,
	appPages,
	portalPages,
	run,
	runAs,
	runMiddleware: runPageMiddleware,
};

/**
 * Shared page dispatch (P-050/P-059/P-081) — the generic pipeline
 * lives in @ktb/app-host/server; this binds it to the app registries
 * and runtime. See `dispatchPage` there for the full contract.
 */
const pageData = (
	path: string,
	shell: PageShell,
	search?: Record<string, unknown>,
): Promise<PageDataResult> => dispatchPage({ path, shell, search }, pageDispatchDeps);

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
 * The tenant bound to this request — selector headers → directory →
 * single-membership default, the same resolution `runAs` applies to
 * page loaders — as `{ id, role, roleRank }`, or null in personal
 * scope / anonymous. `roleRank` is the TENANT_ROLE_RANK ordinal portal
 * shells feed into chrome `when.minUserCounts` gates (as the
 * `tenantRoleRank` facet) so tenant-admin surfaces (e.g. the clinic
 * vault) stay hidden from members, secretaries and patient accounts.
 */
export const boundTenantFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => null,
		async ({ run }) =>
			run(
				Effect.map(Tenant, (tenant) =>
					tenant === null
						? null
						: { id: tenant.id, role: tenant.role, roleRank: TENANT_ROLE_RANK[tenant.role] },
				),
			),
	),
);

/**
 * Audience rule ids the session user satisfies (P-081) — feeds the
 * portal shells' instance switcher and any chrome that varies by
 * audience. Anonymous callers get an empty list. Sorted for stable
 * wire output.
 */
export const portalAudiencesFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => [] as string[],
		async ({ run }): Promise<readonly string[]> =>
			run(
				Effect.gen(function* () {
					const audience = yield* Effect.serviceOption(PortalAudience);
					if (Option.isNone(audience)) return [] as string[];
					return [...(yield* audience.value.audiences())].sort();
				}),
			),
	),
);

/**
 * Console page paths whose `guard` DENIES the session user — the
 * sidebar hides entries pointing at them instead of showing a menu of
 * pages that all 404. Runs each console page's guard once per load
 * (each guard is a permissions lookup — cheap); failures count as
 * denied, same contract as `pageData`. Pages without a guard are
 * never listed: nothing to hide.
 */
export const consoleDeniedFn = createServerFn({ method: "GET" }).handler(
	optionalSessionHandler(
		() => [] as string[],
		async ({ run }) => {
			// Guards run in parallel — each is its own runAs, and serial awaits
			// would multiply sidebar-load latency by the page count. Promise.all
			// preserves portalPages iteration order; failures count as denied,
			// same contract as pageData.
			const checks = await Promise.all(
				[...portalPages.values()].flatMap((entry) => {
					const path = entry.page.path;
					const guard = entry.page.guard ?? serverPageMap().get(path)?.guard;
					if (guard === undefined) return [];
					return [
						run(guard(path))
							.catch(() => false)
							.then((ok) => ({ path, ok })),
					];
				}),
			);
			return checks.filter((check) => !check.ok).map((check) => check.path);
		},
	),
);

/**
 * Loader data for app-shell pages contributed via `pages` (P-059):
 * same dispatch as `portalPageDataFn` but session-optional — public
 * pages run their Effects without a bound Principal. The input is
 * either the bare path string (legacy callers) or
 * `{ path, search }` — `search` is the route's parsed URL search,
 * forwarded to the page loader's optional second argument. Malformed
 * or absent search degrades to `undefined`, never a decode failure.
 */
const AppPageDataInput = Schema.Union([
	Schema.String,
	Schema.Struct({
		path: Schema.String,
		search: Schema.optionalKey(Schema.Unknown),
	}),
]);

const decodeAppPageData = Schema.decodeUnknownSync(AppPageDataInput);

/** Plain-object search records only — arrays, null and primitives
 * are "malformed" wire input and degrade to `undefined`. */
const asSearchRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

export const appPageDataFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => decodeAppPageData(input))
	.handler(async ({ data: input }): Promise<PageDataResult> => {
		const path = typeof input === "string" ? input : input.path;
		const search = typeof input === "string" ? undefined : asSearchRecord(input.search);
		return pageData(path, "app", search);
	});

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
export const listMyNotificationsFn = createServerFn({ method: "GET" }).handler(
	optionalDoctorHandler(
		() => [],
		async ({ user, run }) =>
			run(
				Effect.gen(function* () {
					const notifications = yield* Notifications;
					const rows = yield* notifications.list(user.id, 50);
					return rows.map(rowToConsole);
				}),
			),
	),
);

/** Exact unread count for the /platform dashboard card — the list fn
 * above is capped at 50 rows, so it can't be derived client-side. */
export const countMyUnreadNotificationsFn = createServerFn({ method: "GET" }).handler(
	optionalDoctorHandler(
		() => 0,
		async ({ user, run }) =>
			run(
				Effect.gen(function* () {
					const notifications = yield* Notifications;
					return yield* notifications.unreadCount(user.id);
				}),
			),
	),
);

const decodeNotificationIds = Schema.decodeUnknownSync(Schema.Array(Schema.Number));

/** Mark specific notifications read — ids are the numeric row ids
 * behind ConsoleNotification.id. Missing/foreign ids are ignored by
 * the service's user-scoped UPDATE. */
export const markMyNotificationsReadFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeNotificationIds(input))
	.handler(
		doctorHandler(async ({ data: ids, user, run }) =>
			run(
				Effect.gen(function* () {
					const notifications = yield* Notifications;
					return yield* notifications
						.markRead(user.id, ids)
						.pipe(Effect.as(true), forbiddenTo(false));
				}),
			),
		),
	);

export const markAllMyNotificationsReadFn = createServerFn({ method: "POST" }).handler(
	doctorHandler(async ({ user, run }) =>
		run(
			Effect.gen(function* () {
				const notifications = yield* Notifications;
				return yield* notifications.markAllRead(user.id).pipe(Effect.as(true), forbiddenTo(false));
			}),
		),
	),
);
