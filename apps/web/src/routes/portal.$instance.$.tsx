import { createElement } from "react";
import { createFileRoute, getRouteApi, notFound, useLocation } from "@tanstack/react-router";

import { authClient } from "@ktb/auth-better/client";
import { platformHeaderPlugin } from "@ktb/platform-header";
import { PortalShell } from "@ktb/portal/views";
import { portalAdmits } from "@ktb/portal/rules";
import { themeScopeFn } from "@ktb/theme/fns";
import { themeHead, themeTitle } from "@ktb/theme/head";
import { ThemeBrandMark, ThemePreviewBanner } from "@ktb/theme/views";
import type { ResolvedTheme } from "@ktb/theme/types";

import { pluginStatesFn, portalAudiencesFn, portalPageDataFn } from "#/lib/fns.ts";
import { requireSession } from "#/lib/guard.ts";
import { portalChromeProps } from "#/lib/chrome-props.ts";
import { pluginPanelGroup, pluginPanelLabel } from "#/lib/i18n.ts";
import {
	collectChrome,
	enabledIdSet,
	enabledPlugins,
	findPage,
	findPortalInstance,
	portalInstances,
	portalPages,
} from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";

const rootApi = getRouteApi("__root__");
const headerEnabled = plugins.some((p) => p.id === platformHeaderPlugin.id);

/** `/portal/<instanceId>` + optional splat → the absolute page path
 * portal descriptors register. The bare instance root (empty splat)
 * resolves to `/portal/<instanceId>` itself. */
const pagePath = (instanceId: string, splat: string | undefined): string =>
	splat === undefined || splat === "" ? `/portal/${instanceId}` : `/portal/${instanceId}/${splat}`;

// Namespaced portal dispatcher (P-081): `/portal/<instanceId>/*`
// resolves the contributed `portals` instance by id, 404s when no
// plugin declares it, when its owner plugin is disabled (P-058) or
// when the portalPageDataFn audience/page gate denies, then renders
// the contributed page inside PortalShell with the instance's
// portal.* chrome. Session is required — portal audiences never
// include anonymous. The patient portal's physical /portal routes
// (/portal, /portal/consultations/$id, /portal/login) outrank this
// splat, so they are unaffected.
export const Route = createFileRoute("/portal/$instance/$")({
	beforeLoad: async () => {
		await requireSession();
	},
	loader: async ({ params }) => {
		const entry = findPortalInstance(portalInstances, params.instance);
		if (entry === undefined) throw notFound();
		const path = pagePath(params.instance, params._splat);
		// Client-side early gates mirror platform/$: unknown page, a
		// disabled owning plugin, then the server-side audience+page
		// gate inside portalPageDataFn.
		const pageEntry = findPage(portalPages, path);
		if (pageEntry === undefined) throw notFound();
		const [states, audiences, result, theme] = await Promise.all([
			pluginStatesFn(),
			portalAudiencesFn(),
			portalPageDataFn({ data: path }),
			// Instance → tenant → platform fallback (P-082).
			themeScopeFn({ data: { scope: "portal-instance", id: params.instance } }),
		]);
		const enabled = enabledIdSet(states);
		if (!enabled.has(pageEntry.pluginId) || !enabled.has(entry.pluginId)) {
			throw notFound();
		}
		if (result.status === "notfound") throw notFound();
		return { path, data: result.data, audiences, pluginStates: states, theme };
	},
	// Theme head projection (P-082): favicon/OG/font links + title from
	// the resolved instance theme; PortalShell emits the single style
	// block via `themeCss`.
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
	component: function PortalInstanceRoute() {
		const { instance: instanceId } = Route.useParams();
		const { path, data, audiences, pluginStates, theme } = Route.useLoaderData();
		const pathname = useLocation({ select: (l) => l.pathname });
		const { user, i18n } = rootApi.useLoaderData();
		const locale = i18n?.locale ?? "en";
		const entry = findPortalInstance(portalInstances, instanceId);
		const pageEntry = findPage(portalPages, path);
		if (entry === undefined || pageEntry === undefined) return null;
		const instance = entry.instance;
		const visiblePlugins = enabledPlugins(plugins, enabledIdSet(pluginStates));
		const items = collectChrome(visiblePlugins, "portal.sidebar", pathname, instance.id).flatMap(
			(chromeEntry) =>
				chromeEntry.content.kind === "sidebarItem"
					? [
							{
								...chromeEntry.content.item,
								label: pluginPanelLabel(
									chromeEntry.content.item.to,
									chromeEntry.content.item.label,
									i18n,
								),
								...(chromeEntry.content.item.group !== undefined
									? { group: pluginPanelGroup(chromeEntry.content.item.group, i18n) }
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
			theme !== null &&
			theme !== undefined &&
			(theme.brand !== null || (theme.appName ?? "") !== "");
		const brand =
			hasThemeBrand || brandComponents.length > 0 ? (
				<>
					{hasThemeBrand ? <ThemeBrandMark theme={theme} /> : null}
					{brandComponents}
				</>
			) : undefined;
		const themeCss =
			theme !== null && theme !== undefined
				? `${theme.styleCss}\n${theme.fontFaceCss}`.trim()
				: null;
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
	},
});
