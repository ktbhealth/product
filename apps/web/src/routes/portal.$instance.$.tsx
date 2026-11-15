import { createElement } from "react";
import { createFileRoute, getRouteApi, notFound, useLocation } from "@tanstack/react-router";

import { authClient } from "@ktb/auth-better/client";
import { platformHeaderPlugin } from "@ktb/platform-header";
import { PortalShell } from "@ktb/portal/views";
import { portalAdmits } from "@ktb/portal/rules";

import { pluginStatesFn, portalAudiencesFn, portalPageDataFn } from "#/lib/fns.ts";
import { requireSession } from "#/lib/guard.ts";
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
import { getLocale } from "#/paraglide/runtime.js";

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
		const [states, audiences, result] = await Promise.all([
			pluginStatesFn(),
			portalAudiencesFn(),
			portalPageDataFn({ data: path }),
		]);
		const enabled = enabledIdSet(states);
		if (!enabled.has(pageEntry.pluginId) || !enabled.has(entry.pluginId)) {
			throw notFound();
		}
		if (result.status === "notfound") throw notFound();
		return { path, data: result.data, audiences, pluginStates: states };
	},
	component: function PortalInstanceRoute() {
		const { instance: instanceId } = Route.useParams();
		const { path, data, audiences, pluginStates } = Route.useLoaderData();
		const pathname = useLocation({ select: (l) => l.pathname });
		const { user } = rootApi.useLoaderData();
		const locale = getLocale();
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
								),
								...(chromeEntry.content.item.group !== undefined
									? { group: pluginPanelGroup(chromeEntry.content.item.group) }
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
									}),
								]
							: [],
				)
			: undefined;
		const switchablePortals = portalInstances
			.filter((e) => portalAdmits(e.instance, audiences))
			.map((e) => e.instance);
		return (
			<PortalShell
				instance={instance}
				items={items}
				pathname={pathname}
				locale={locale}
				userEmail={user?.email}
				headerActions={headerActions}
				portals={switchablePortals}
				onSignOut={async () => {
					await authClient.signOut();
					window.location.assign("/");
				}}
			>
				{createElement(pageEntry.page.component, {
					data,
					ctx: { plugins, locale, user },
				})}
			</PortalShell>
		);
	},
});
