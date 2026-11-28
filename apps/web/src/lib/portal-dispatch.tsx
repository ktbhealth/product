import { createElement } from "react";
import { getRouteApi, notFound, redirect, useLocation } from "@tanstack/react-router";

import { authClient } from "@ktb/auth-better/client";
import { platformHeaderPlugin } from "@ktb/platform-header";
import { PortalShell } from "@ktb/portal/views";
import { portalAdmits } from "@ktb/portal/rules";
import { themeScopeFn } from "@ktb/theme/fns";
import { ThemeBrandMark, ThemePreviewBanner } from "@ktb/theme/views";
import type { ResolvedTheme } from "@ktb/theme/types";
import type { TenantRole } from "@ktb/tenant";

import { boundTenantFn, pluginStatesFn, portalAudiencesFn, portalPageDataFn } from "#/lib/fns.ts";
import { requireSession } from "#/lib/guard.ts";
import { portalChromeProps } from "#/lib/chrome-props.ts";
import { pluginGroupLabel, pluginItemLabel } from "#/lib/i18n.ts";
import {
	collectChrome,
	collectI18nKeys,
	enabledIdSet,
	enabledPlugins,
	entryEnabled,
	findPage,
	findPortalInstance,
	portalInstances,
	portalPages,
} from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";

const rootApi = getRouteApi("__root__");
const headerEnabled = plugins.some((p) => p.id === platformHeaderPlugin.id);

/**
 * Namespaced portal dispatch (was routes/portal.$instance.$.tsx):
 * `/portal/<instanceId>/*` resolves the contributed `portals`
 * instance by id, 404s when no plugin declares it, when its owner
 * plugin is disabled (P-058) or when the portalPageDataFn
 * audience/page gate denies, then renders the contributed page
 * inside PortalShell with the instance's portal.* chrome. Session is
 * required — portal audiences never include anonymous. Unknown
 * instance ids never reach this module: dispatch-target.ts falls
 * them through to app pages.
 */
export const portalBeforeLoad = async (instanceId: string) => {
	// Each portal's anonymous funnel lands on the matching sign-in —
	// the three contributed instance ids mirror the login paths; any
	// other id falls back to the /login role picker.
	const loginPath = ["doctor", "secretary", "patient"].includes(instanceId)
		? `/login/${instanceId}`
		: "/login";
	await requireSession(loginPath);
};

export const portalLoader = async ({
	params,
	instanceId,
}: {
	params: { _splat?: string };
	instanceId: string;
}) => {
	const path = `/${params._splat ?? ""}`;
	const entry = findPortalInstance(portalInstances, instanceId);
	if (entry === undefined) throw notFound();
	const pageEntry = findPage(portalPages, path);
	if (pageEntry === undefined) throw notFound();
	// Enablement resolves BEFORE the page-data server fn is invoked:
	// the side-effect-free reads (states/audiences/theme/tenant) race,
	// the package gate runs, and only a live entry reaches
	// portalPageDataFn — the same ordering the server-side pageData
	// middleware stages enforce, so a disabled plugin's loader work
	// never starts.
	const [states, audiences, theme, tenant] = await Promise.all([
		pluginStatesFn(),
		portalAudiencesFn(),
		// Instance → tenant → platform fallback (P-082).
		themeScopeFn({ data: { scope: "portal-instance", id: instanceId } }),
		// Bound tenant for `when.minUserCounts` chrome gates.
		boundTenantFn(),
	]);
	const enabled = enabledIdSet(states);
	// Package-granular gates (P-058): both the page's package and the
	// portal instance's package must be live — same contract as the
	// server-side pageData/CQRS gates.
	if (!entryEnabled(plugins, enabled, pageEntry) || !entryEnabled(plugins, enabled, entry)) {
		throw notFound();
	}
	const result = await portalPageDataFn({ data: path });
	if (result.status === "notfound") throw notFound();
	if (result.status === "redirect") throw redirect({ href: result.to });
	return { path, instanceId, data: result.data, audiences, pluginStates: states, theme, tenant };
};

export interface PortalLoaderData {
	path: string;
	instanceId: string;
	data: unknown;
	audiences: readonly string[];
	pluginStates: { enabled: readonly string[] };
	theme: ResolvedTheme | null;
	/** Bound tenant ({ id, role, roleRank }) or null in personal scope —
	 * `roleRank` feeds the `tenantRoleRank` chrome facet. */
	tenant: {
		readonly id: string | number;
		readonly role: TenantRole;
		readonly roleRank: number;
	} | null;
}

export function PortalInstanceShell({ loaderData }: { loaderData: PortalLoaderData }) {
	const { path, instanceId, data, audiences, pluginStates, theme, tenant } = loaderData;
	const pathname = useLocation({ select: (l) => l.pathname });
	const { user, i18n } = rootApi.useLoaderData();
	const locale = i18n?.locale ?? "en";
	const entry = findPortalInstance(portalInstances, instanceId);
	const pageEntry = findPage(portalPages, path);
	if (entry === undefined || pageEntry === undefined) return null;
	const instance = entry.instance;
	const visiblePlugins = enabledPlugins(plugins, enabledIdSet(pluginStates));
	// Chrome user gains the bound tenant's role rank so
	// `when.minUserCounts: { tenantRoleRank }` gates evaluate;
	// unresolved tenant → undefined → those gates fail closed.
	const chromeUser =
		user === null || user === undefined ? user : { ...user, tenantRoleRank: tenant?.roleRank };
	const i18nKeys = collectI18nKeys(visiblePlugins);
	const items = collectChrome(
		visiblePlugins,
		"portal.sidebar",
		pathname,
		instance.id,
		chromeUser,
	).flatMap((chromeEntry) =>
		chromeEntry.content.kind === "sidebarItem"
			? [
					{
						...chromeEntry.content.item,
						label: pluginItemLabel(
							chromeEntry.content.item.to,
							chromeEntry.content.item.label,
							i18n,
							i18nKeys,
						),
						...(chromeEntry.content.item.group !== undefined
							? { group: pluginGroupLabel(chromeEntry.content.item.group, i18n, i18nKeys) }
							: {}),
					},
				]
			: [],
	);
	const headerActions = headerEnabled
		? collectChrome(visiblePlugins, "portal.header.actions", pathname, instance.id).flatMap(
				(chromeEntry) =>
					chromeEntry.content.kind === "headerAction"
						? [
								createElement(chromeEntry.content.component, {
									key: chromeEntry.content.id,
									locale,
									i18n,
								}),
							]
						: [],
			)
		: undefined;
	const switchablePortals = portalInstances
		.filter((e) => portalAdmits(e.instance, audiences))
		.map((e) => e.instance);
	// Brand slot (P-082/PL-006): theme brand mark + `portal.brand`
	// chrome components scoped to THIS instance. The built-in KTB
	// default keeps brand data present with zero theme rows; an
	// empty slot renders only for brand-less themes.
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
		// A pinned portal locale (PL-008) leaves the picker a single
		// option — effectively hidden, since the cookie can't win.
		instance.locale === undefined ? undefined : [instance.locale],
	);
	const brandComponents = collectChrome(
		visiblePlugins,
		"portal.brand",
		pathname,
		instance.id,
	).flatMap((chromeEntry) =>
		chromeEntry.content.kind === "component"
			? [
					createElement(chromeEntry.content.component, {
						key: chromeEntry.id,
						...chromeProps,
					}),
				]
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
	return (
		<PortalShell
			instance={instance}
			items={items}
			pathname={pathname}
			locale={locale}
			i18n={i18n}
			userEmail={user?.email}
			headerActions={headerActions}
			brand={brand}
			banner={
				theme?.preview === true ? <ThemePreviewBanner locale={locale} i18n={i18n} /> : undefined
			}
			themeCss={themeCss}
			portals={switchablePortals}
			onSignOut={async () => {
				await authClient.signOut();
				window.location.assign("/");
			}}
		>
			{createElement(pageEntry.page.component, {
				data,
				ctx: { plugins, locale, user, i18n },
			})}
		</PortalShell>
	);
}
