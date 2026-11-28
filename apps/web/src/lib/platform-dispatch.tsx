import { createElement } from "react";
import { getRouteApi, notFound, redirect, useLocation } from "@tanstack/react-router";

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
	portalPageDataFn,
} from "#/lib/fns.ts";
import { requireSession } from "#/lib/guard.ts";
import { portalChromeProps } from "#/lib/chrome-props.ts";
import { pluginGroupLabel, pluginItemLabel } from "#/lib/i18n.ts";
import {
	collectChrome,
	collectI18nKeys,
	enabledIdSet,
	enabledPlugins,
	findPage,
	KNOWN_CHROME_REGIONS,
	packageLive,
	portalInstances,
	portalPages,
	warnUnknownChromeRegions,
	entryEnabled,
	findPortalInstance,
} from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";

const rootApi = getRouteApi("__root__");

// /platform console dispatch (was routes/platform.tsx layout +
// platform/index.tsx + platform/$.tsx): the platform admin console is
// the default portal instance. The gate is server-side — non-admins
// get a hard 404, never just hidden nav. Header widgets, dashboard
// feeds and sidebar chrome behave exactly as the layout route did.
const headerEnabled = plugins.some((p) => p.id === platformHeaderPlugin.id);
const hasJobsPlugin = plugins.some((p) => p.id === "jobs.header");
const hasNotificationsPlugin = plugins.some((p) => p.id === "notifications.services");

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
	"/platform/pipelines",
	"/platform/eval/personas",
	"/platform/eval/instances",
	"/platform/eval",
	"/platform/pages",
	"/platform/theme",
	"/platform/i18n",
	"/platform/wizards",
	"/platform/plugins",
	"/platform/middleware",
	"/platform/ops",
	"/platform/queue",
	"/platform/cron",
	"/platform/pubsub",
	"/platform/ai/machines",
	"/platform/audit",
];
const sidebarRank = new Map(PLATFORM_SIDEBAR_ORDER.map((to, index) => [to, index]));

// This shell declares the portal.* chrome regions (P-060/P-081);
// plugins fill them via `chrome` contributions. The dev warning uses
// the union of all shell regions so app.* contributions aren't false
// positives.
if (import.meta.env.DEV) warnUnknownChromeRegions(plugins, KNOWN_CHROME_REGIONS);

export const platformBeforeLoad = async () => {
	await requireSession("/login/doctor");
	if (!(await platformAdminFn())) throw notFound();
};

export const platformLoader = async ({ params }: { params: { _splat?: string } }) => {
	const path = `/${params._splat ?? ""}`;
	// findPage: exact descriptors win; "/*" wildcards (DB-backed
	// pages) resolve by longest matching base.
	const pageEntry = findPage(portalPages, path);
	if (pageEntry === undefined) throw notFound();
	// Enablement resolves BEFORE the page-data server fn is invoked:
	// the side-effect-free reads (states/audiences/theme/denied list)
	// race, the package gate runs, and only a live entry reaches
	// portalPageDataFn — the same ordering the server-side pageData
	// middleware stages enforce, so a disabled plugin's loader work
	// never starts.
	const [pluginStates, audiences, theme, deniedPaths] = await Promise.all([
		pluginStatesFn(),
		portalAudiencesFn(),
		// Instance → tenant → platform fallback (P-082).
		themeScopeFn({ data: { scope: "portal-instance", id: "platform" } }),
		consoleDeniedFn(),
	]);
	const enabled = enabledIdSet(pluginStates);
	// Package-granular gates (P-058): the page's package must be live —
	// same contract as the server-side pageData/CQRS gates.
	if (!entryEnabled(plugins, enabled, pageEntry)) throw notFound();
	const pageResult = await portalPageDataFn({ data: path });
	if (pageResult.status === "notfound") throw notFound();
	// Middleware `redirect` verdicts (PL-015) surface as router redirects.
	if (pageResult.status === "redirect") throw redirect({ href: pageResult.to });
	// Enabled-state gate (P-058): skip feeds whose plugin package is
	// fully disabled — the CQRS/service calls would fail or return
	// data for a plugin the admin turned off.
	const [audioJobs, notifications, consultations, patients, unreadCount] = await Promise.all([
		hasJobsPlugin && packageLive(plugins, enabled, "consultations")
			? adminListAudioJobsFn()
			: Promise.resolve([]),
		hasNotificationsPlugin && packageLive(plugins, enabled, "notifications")
			? listMyNotificationsFn()
			: Promise.resolve([]),
		packageLive(plugins, enabled, "consultations")
			? adminListConsultationsFn()
			: Promise.resolve([]),
		packageLive(plugins, enabled, "patients") ? adminListPatientsFn() : Promise.resolve([]),
		hasNotificationsPlugin && packageLive(plugins, enabled, "notifications")
			? countMyUnreadNotificationsFn()
			: Promise.resolve(undefined),
	]);
	return {
		path,
		pageData: pageResult.data,
		audioJobs,
		notifications,
		consultations,
		patients,
		unreadCount,
		audiences,
		theme,
		deniedPaths,
		pluginStates,
	};
};

export interface PlatformLoaderData {
	path: string;
	pageData: unknown;
	audioJobs: unknown;
	notifications: unknown;
	consultations: unknown;
	patients: unknown;
	unreadCount: number | undefined;
	audiences: readonly string[];
	theme: ResolvedTheme | null;
	deniedPaths: readonly string[];
	pluginStates: { enabled: readonly string[] };
}

export function PlatformShell({ loaderData }: { loaderData: PlatformLoaderData }) {
	const pathname = useLocation({ select: (l) => l.pathname });
	const { user, pluginStates, i18n } = rootApi.useLoaderData();
	const {
		path,
		pageData,
		audioJobs,
		notifications,
		consultations,
		patients,
		unreadCount,
		audiences,
		theme,
		deniedPaths,
	} = loaderData;
	const locale = i18n?.locale ?? "en";
	const visiblePlugins = enabledPlugins(plugins, enabledIdSet(pluginStates));
	const denied = new Set(deniedPaths);
	const i18nKeys = collectI18nKeys(visiblePlugins);
	const items = collectChrome(visiblePlugins, "portal.sidebar", pathname, "platform", user).flatMap(
		(entry) =>
			entry.content.kind === "sidebarItem" && !denied.has(entry.content.item.to)
				? [
						{
							...entry.content.item,
							label: pluginItemLabel(
								entry.content.item.to,
								entry.content.item.label,
								i18n,
								i18nKeys,
							),
							...(entry.content.item.group !== undefined
								? { group: pluginGroupLabel(entry.content.item.group, i18n, i18nKeys) }
								: {}),
						},
					]
				: [],
	);
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
	const themeCss =
		theme !== null && theme !== undefined ? `${theme.styleCss}\n${theme.fontFaceCss}`.trim() : null;
	const switchablePortals = portalInstances
		.filter((e) => portalAdmits(e.instance, audiences))
		.map((e) => e.instance);
	const notificationActions: NotificationsActions | null = hasNotificationsPlugin
		? {
				markRead: (ids) => markMyNotificationsReadFn({ data: [...ids] }),
				markAllRead: () => markAllMyNotificationsReadFn(),
			}
		: null;
	const pageEntry = findPage(portalPages, path);
	const page =
		pageEntry === undefined
			? null
			: createElement(pageEntry.page.component, {
					data: pageData,
					// ctx.plugins is the FULL discovered registry — the
					// /platform/plugins manager needs disabled plugins too.
					ctx: { plugins, locale, user, i18n, pluginStates },
				});
	return (
		<JobsDataContext.Provider value={jobsFromAudioRows(audioJobs as never, locale)}>
			<NotificationsDataContext.Provider value={notifications as never}>
				<NotificationsUnreadContext.Provider value={unreadCount}>
					<NotificationsActionsContext.Provider value={notificationActions}>
						<ConsultationsDashboardContext.Provider value={consultations as never}>
							<PatientsDashboardContext.Provider value={patients as never}>
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
									{page}
								</PortalShell>
							</PatientsDashboardContext.Provider>
						</ConsultationsDashboardContext.Provider>
					</NotificationsActionsContext.Provider>
				</NotificationsUnreadContext.Provider>
			</NotificationsDataContext.Provider>
		</JobsDataContext.Provider>
	);
}
