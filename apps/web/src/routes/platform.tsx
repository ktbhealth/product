import { createElement } from "react";
import {
	createFileRoute,
	getRouteApi,
	notFound,
	Outlet,
	useLocation,
} from "@tanstack/react-router";

import { authClient } from "@ktb/auth-better/client";
import { platformHeaderPlugin } from "@ktb/platform-header";
import { PortalShell } from "@ktb/portal/views";
import { portalAdmits } from "@ktb/portal/rules";
import { JobsDataContext, jobsFromAudioRows } from "@ktb/jobs";
import { adminListAudioJobsFn, adminListConsultationsFn } from "@ktb/consultations/fns";
import { ConsultationsDashboardContext } from "@ktb/consultations/context";
import { adminListPatientsFn } from "@ktb/patients/fns";
import { PatientsDashboardContext } from "@ktb/patients/context";
import {
	NotificationsActionsContext,
	NotificationsDataContext,
	NotificationsUnreadContext,
	type NotificationsActions,
} from "@ktb/notifications/context";
import { themeScopeFn } from "@ktb/theme/fns";
import { themeHead, themeTitle } from "@ktb/theme/head";
import { ThemeBrandMark, ThemePreviewBanner } from "@ktb/theme/views";
import type { ResolvedTheme } from "@ktb/theme/types";

import {
	consoleDeniedFn,
	countMyUnreadNotificationsFn,
	listMyNotificationsFn,
	markAllMyNotificationsReadFn,
	markMyNotificationsReadFn,
	platformAdminFn,
	pluginStatesFn,
	portalAudiencesFn,
} from "#/lib/fns.ts";
import { requireSession } from "#/lib/guard.ts";
import { portalChromeProps } from "#/lib/chrome-props.ts";
import { pluginPanelGroup, pluginPanelLabel } from "#/lib/i18n.ts";
import {
	collectChrome,
	enabledIdSet,
	enabledPlugins,
	findPortalInstance,
	KNOWN_CHROME_REGIONS,
	packageLive,
	portalInstances,
	warnUnknownChromeRegions,
} from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";

// /platform portal shell (P-031/P-081): the platform admin console is the
// default portal instance — the root route drops its marketing chrome on
// /platform* and this layout owns the full viewport. The chrome itself
// (sidebar, breadcrumb header, sign-out, portal switcher) is the
// @ktb/portal PortalShell view; this route keeps the admin gate and
// injects the instance's aggregated portal.* chrome items. The gate is
// server-side — non-admins get a hard 404, never just hidden nav.
//
// Header widgets: when the platform.header extension-point plugin is
// registered, every plugin's `portal.header.actions` chrome render on the right
// side of the top bar. The jobs feed is provided through
// JobsDataContext, fed by the `consultations.audioJobs` CQRS query
// (dispatched by adminListAudioJobsFn — the jobs plugin never reaches
// into consultations tables); the notifications feed is seeded through
// NotificationsDataContext, kept live by the header action's
// /api/notifications EventSource, and gets mark-read actions through
// NotificationsActionsContext (only when the notifications backend is
// registered). Plugins without header actions are unaffected.
const headerEnabled = plugins.some((p) => p.id === platformHeaderPlugin.id);
const hasJobsPlugin = plugins.some((p) => p.id === "jobs.header");
const hasNotificationsPlugin = plugins.some((p) => p.id === "notifications.services");

// The "platform" instance descriptor (P-081) — contributed by
// platform.portal; absent only in degenerate registries, where the
// shell falls back to a barebones instance.
const platformEntry = findPortalInstance(portalInstances, "platform");
const platformInstance = platformEntry?.instance ?? {
	id: "platform",
	basePath: "/platform",
	label: "Platform",
};

// Sidebar IA order: the technical layering (console → identity →
// domain data → storage → intelligence → evaluation →
// presentation → runtime → assurance). Plugin topo order is dep-driven, not
// IA-driven, so the console pins the sequence by destination; items
// a plugin contributes that aren't listed keep their topo order at
// the end.
const PLATFORM_SIDEBAR_ORDER: readonly string[] = [
	"/platform",
	"/platform/users",
	"/platform/groups",
	"/platform/roles",
	"/platform/tenants",
	"/platform/ai/credentials",
	"/platform/patients",
	"/platform/consultations",
	"/platform/document-store",
	"/platform/kv",
	"/platform/ai/models",
	"/platform/ai/prompts",
	"/platform/ai/endpoints",
	"/platform/ai/agents",
	"/platform/eval/personas",
	"/platform/eval/instances",
	"/platform/eval",
	"/platform/pages",
	"/platform/theme",
	"/platform/i18n",
	"/platform/wizards",
	"/platform/plugins",
	"/platform/ops",
	"/platform/ai/machines",
	"/platform/audit",
];
const sidebarRank = new Map(PLATFORM_SIDEBAR_ORDER.map((to, index) => [to, index]));

// This shell declares the portal.* chrome regions (P-060/P-081);
// plugins fill them via `chrome` contributions. The dev warning uses
// the union of all shell regions so app.* contributions aren't false
// positives.
if (import.meta.env.DEV) warnUnknownChromeRegions(plugins, KNOWN_CHROME_REGIONS);

export const Route = createFileRoute("/platform")({
	beforeLoad: async () => {
		await requireSession("/login/doctor");
		if (!(await platformAdminFn())) throw notFound();
	},
	loader: async () => {
		// Enabled-state gate (P-058): skip feeds whose plugin package is
		// fully disabled — the CQRS/service calls would fail or return
		// data for a plugin the admin turned off. Audience rules (P-081)
		// feed the shell's portal switcher. The theme resolves
		// portal-instance ("platform") → tenant → platform (P-082).
		const [pluginStates, audiences, theme] = await Promise.all([
			pluginStatesFn(),
			portalAudiencesFn(),
			themeScopeFn({ data: { scope: "portal-instance", id: "platform" } }),
		]);
		const enabled = enabledIdSet(pluginStates);
		return {
			// Package-granular gates (P-058): skip feeds whose plugin
			// package is fully disabled — the same contract the CQRS
			// dispatch gate applies to the fns below.
			audioJobs:
				hasJobsPlugin && packageLive(plugins, enabled, "consultations")
					? await adminListAudioJobsFn()
					: [],
			notifications:
				hasNotificationsPlugin && packageLive(plugins, enabled, "notifications")
					? await listMyNotificationsFn()
					: [],
			// Dashboard slot feeds (T-125): the domain plugins' contributed
			// portal.dashboard.* components read these through their
			// contexts — empty arrays when the package is off.
			consultations: packageLive(plugins, enabled, "consultations")
				? await adminListConsultationsFn()
				: [],
			patients: packageLive(plugins, enabled, "patients") ? await adminListPatientsFn() : [],
			// Exact unread count for the dashboard's console-activity card —
			// the notifications feed above is capped, so it cannot be
			// derived client-side.
			unreadCount:
				hasNotificationsPlugin && packageLive(plugins, enabled, "notifications")
					? await countMyUnreadNotificationsFn()
					: undefined,
			audiences,
			theme,
			// Guard-filtered sidebar: page paths whose guard denies this
			// user — items pointing there would just 404.
			deniedPaths: await consoleDeniedFn(),
		};
	},
	// Theme head projection (P-082): favicon/OG/font links + title from
	// the resolved instance theme. The `:root`/`.dark` style block is
	// NOT emitted here — PortalShell owns the single style emitter via
	// `themeCss`, so console pages never double-inject.
	head: (ctx) => {
		const theme = ((ctx?.loaderData as { theme?: ResolvedTheme | null } | undefined)?.theme ??
			null) as ResolvedTheme | null;
		if (theme === null) return {};
		const head = themeHead(theme);
		const title = themeTitle(theme);
		return {
			meta: [...(title !== null ? [{ title }] : []), ...head.meta],
			links: [...head.links],
		};
	},
	component: PlatformLayout,
});

const rootApi = getRouteApi("__root__");

function PlatformLayout() {
	const pathname = useLocation({ select: (l) => l.pathname });
	const { user, pluginStates, i18n } = rootApi.useLoaderData();
	const {
		audioJobs,
		notifications,
		consultations,
		patients,
		unreadCount,
		audiences,
		theme,
		deniedPaths,
	} = Route.useLoaderData();
	const locale = i18n?.locale ?? "en";
	// Enabled-state filter (P-058): disabled plugins contribute no
	// sidebar items or header actions.
	const visiblePlugins = enabledPlugins(plugins, enabledIdSet(pluginStates));
	// Guard filter: sidebar items pointing at pages whose guard denied
	// this user are hidden — a menu of 404s is worse than a short menu.
	// Items without a matching guarded page are never denied.
	const denied = new Set(deniedPaths);
	// Sidebar/header chrome comes from `chrome` contributions into the
	// portal.* regions (P-060/P-081), scoped to the "platform" instance
	// and filtered by `when` against the pathname. Sidebar labels/groups
	// are plugin-declared English strings; the host maps the known
	// destinations/groups to localized chrome (same mechanism as the
	// landing nav's pluginNavLabel).
	const items = collectChrome(visiblePlugins, "portal.sidebar", pathname, "platform", user).flatMap(
		(entry) =>
			entry.content.kind === "sidebarItem" && !denied.has(entry.content.item.to)
				? [
						{
							...entry.content.item,
							label: pluginPanelLabel(entry.content.item.to, entry.content.item.label, i18n),
							...(entry.content.item.group !== undefined
								? { group: pluginPanelGroup(entry.content.item.group, i18n) }
								: {}),
						},
					]
				: [],
	);
	// Stable rank sort: listed destinations follow PLATFORM_SIDEBAR_ORDER;
	// unlisted ones (rank miss) sink to the end keeping topo order.
	const orderedItems = [...items].sort(
		(a, b) =>
			(sidebarRank.get(a.to) ?? Number.MAX_SAFE_INTEGER) -
			(sidebarRank.get(b.to) ?? Number.MAX_SAFE_INTEGER),
	);
	const headerActions = headerEnabled
		? collectChrome(visiblePlugins, "portal.header.actions", pathname, "platform").flatMap(
				(entry) =>
					entry.content.kind === "headerAction"
						? [
								createElement(entry.content.component, {
									key: entry.content.id,
									locale,
									i18n,
								}),
							]
						: [],
			)
		: undefined;
	// Brand slot (P-082/PL-006): resolved theme's brand mark plus any
	// `portal.brand` chrome components scoped to this instance. The
	// theme resolves to the built-in KTB default when no row matches,
	// so brand data is always present; PortalShell renders an empty
	// slot only if a theme carries no brand at all.
	const chromeProps = portalChromeProps(
		user,
		locale,
		visiblePlugins,
		async () => {
			await authClient.signOut();
			window.location.assign("/");
		},
		theme,
		i18n,
	);
	const brandComponents = collectChrome(
		visiblePlugins,
		"portal.brand",
		pathname,
		"platform",
	).flatMap((entry) =>
		entry.content.kind === "component"
			? [createElement(entry.content.component, { key: entry.id, ...chromeProps })]
			: [],
	);
	const hasThemeBrand =
		theme !== null && theme !== undefined && (theme.brand !== null || (theme.appName ?? "") !== "");
	const brand =
		hasThemeBrand || brandComponents.length > 0 ? (
			<>
				{hasThemeBrand ? <ThemeBrandMark theme={theme} /> : null}
				{brandComponents}
			</>
		) : undefined;
	// PortalShell owns the single theme style emitter (P-082).
	const themeCss =
		theme !== null && theme !== undefined ? `${theme.styleCss}\n${theme.fontFaceCss}`.trim() : null;
	// Portal switcher (P-081): every instance whose audience rule the
	// session satisfies — the shell hides the picker below two.
	const switchablePortals = portalInstances
		.filter((e) => portalAdmits(e.instance, audiences))
		.map((e) => e.instance);
	// Host-injected write path for the notifications popover — plugins
	// never import server fns; the context stays null when the
	// notifications backend isn't registered so the UI hides the
	// affordances instead of offering dead buttons.
	const notificationActions: NotificationsActions | null = hasNotificationsPlugin
		? {
				markRead: (ids) => markMyNotificationsReadFn({ data: [...ids] }),
				markAllRead: () => markAllMyNotificationsReadFn(),
			}
		: null;
	return (
		<JobsDataContext.Provider value={jobsFromAudioRows(audioJobs, locale)}>
			<NotificationsDataContext.Provider value={notifications}>
				<NotificationsUnreadContext.Provider value={unreadCount}>
					<NotificationsActionsContext.Provider value={notificationActions}>
						<ConsultationsDashboardContext.Provider value={consultations}>
							<PatientsDashboardContext.Provider value={patients}>
								<PortalShell
									instance={platformInstance}
									items={orderedItems}
									pathname={pathname}
									locale={locale}
									i18n={i18n}
									userEmail={user?.email}
									headerActions={headerActions}
									brand={brand}
									banner={
										theme?.preview === true ? (
											<ThemePreviewBanner locale={locale} i18n={i18n} />
										) : undefined
									}
									themeCss={themeCss}
									portals={switchablePortals}
									onSignOut={async () => {
										await authClient.signOut();
										window.location.assign("/");
									}}
								>
									<Outlet />
								</PortalShell>
							</PatientsDashboardContext.Provider>
						</ConsultationsDashboardContext.Provider>
					</NotificationsActionsContext.Provider>
				</NotificationsUnreadContext.Provider>
			</NotificationsDataContext.Provider>
		</JobsDataContext.Provider>
	);
}
