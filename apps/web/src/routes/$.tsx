import { createElement } from "react";
import { createFileRoute, getRouteApi, notFound, redirect } from "@tanstack/react-router";

import { appPageDataFn, pluginStatesFn } from "#/lib/fns.ts";
import { i18nSliceFromHeadMatches } from "#/lib/i18n.ts";
import { appPages, enabledIdSet, enabledPlugins, entryEnabled, findPage } from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";
import type { PageHookContext } from "@ktb/kernel";

const rootApi = getRouteApi("__root__");

const pagePath = (splat: string | undefined): string => `/${splat ?? ""}`;

const hookParams = (params: unknown): Readonly<Record<string, string | undefined>> =>
	(params ?? {}) as Readonly<Record<string, string | undefined>>;

const hookSearch = (search: unknown): Readonly<Record<string, unknown>> =>
	(typeof search === "object" && search !== null && !Array.isArray(search)
		? (search as Record<string, unknown>)
		: {}) as Readonly<Record<string, unknown>>;

const headLocation = (
	pathname: string,
	search: Readonly<Record<string, unknown>>,
): PageHookContext["location"] => {
	const searchStr = new URLSearchParams(
		Object.entries(search).flatMap(([key, value]) =>
			value === undefined ? [] : [[key, String(value)]],
		),
	).toString();
	return {
		pathname,
		searchStr: searchStr === "" ? "" : `?${searchStr}`,
		href: `${pathname}${searchStr === "" ? "" : `?${searchStr}`}`,
	};
};

// Generic dispatcher for app-shell pages contributed via `pages`
// (P-059): plugins declare descriptors keyed by absolute path
// ("/about", "/status", …); this root splat catches every path the
// static file routes don't claim (TanStack ranks literals above
// splats, so plugin file routes keep winning) and resolves
// `/${_splat}` against the app-context registry. Unknown paths 404
// exactly like before; a disabled owning plugin or a `guard` denial
// 404s the same way. App pages may be PUBLIC — `appPageDataFn` runs
// the loader Effect without a bound Principal when nobody is signed
// in, so page authors guard/authz inside their Effects as usual.
// `ctx.plugins` is the enabled-filtered client registry (P-058),
// `ctx.user` the session user or null, `ctx.pluginStates` the raw
// enablement snapshot plugin chrome gates (login tiles) check against.
export const Route = createFileRoute("/$")({
	// Page `beforeLoad` runs after the winning descriptor resolves —
	// one splat route cannot declare a different hook per page, so the
	// descriptor's isomorphic hook is invoked here with the same facts
	// TanStack would pass a file route.
	beforeLoad: async ({ params, search, location, context }) => {
		const path = pagePath(params._splat);
		const entry = findPage(appPages, path);
		const hook = entry?.page.beforeLoad;
		if (hook === undefined) return;
		const result = await hook({
			path,
			params: hookParams(params),
			search: hookSearch(search),
			location: {
				pathname: location.pathname,
				searchStr: location.searchStr,
				href: location.href,
			},
			context,
		});
		if (result === undefined || result === null || typeof result !== "object") return;
		const outcome = result as Record<string, unknown>;
		if (typeof outcome.redirectTo === "string") {
			throw redirect({ href: outcome.redirectTo, replace: outcome.replace === true });
		}
		if (outcome.notFound === true) throw notFound();
		return result as never;
	},
	// `loaderDeps` carries the parsed search into the loader: query
	// changes re-run it, so schema-bound pages re-validate their params
	// inside the page Effect (SSR and client navigations alike).
	loaderDeps: ({ search }) => ({ search }),
	loader: async ({ params, deps }) => {
		const path = pagePath(params._splat);
		// findPage: exact descriptors win; "/*" wildcards (DB-backed
		// pages) resolve by longest matching base.
		const entry = findPage(appPages, path);
		if (entry === undefined) throw notFound();
		// Client-side early gate: a disabled package's page 404s before
		// the server fn round-trip (appPageDataFn re-checks server-side
		// with the same package-granular contract).
		const states = await pluginStatesFn();
		if (!entryEnabled(plugins, enabledIdSet(states), entry)) throw notFound();
		const hasSearch = deps.search !== undefined;
		const rawSearch = hasSearch ? hookSearch(deps.search) : undefined;
		const search = hasSearch
			? (entry.page.validateSearch?.({
					search: rawSearch ?? {},
					path,
					params: hookParams(params),
				}) ?? rawSearch)
			: undefined;
		const result = await appPageDataFn({ data: { path, search } });
		if (result.status === "notfound") throw notFound();
		return { data: result.data, pluginStates: states };
	},
	head: (ctx) => {
		const path = pagePath(ctx.params._splat);
		const entry = findPage(appPages, path);
		const hook = entry?.page.head;
		if (hook === undefined) return {} as never;
		const search = hookSearch(ctx.match?.search);
		const pathname = ctx.match?.pathname ?? path;
		return (hook({
			path,
			params: hookParams(ctx.params),
			search,
			location: headLocation(pathname, search),
			loaderData: ctx.loaderData,
			matches: ctx.matches,
			i18n: i18nSliceFromHeadMatches(ctx.matches),
		}) ?? {}) as never;
	},
	component: function AppPageRoute() {
		const { _splat } = Route.useParams();
		const { data, pluginStates } = Route.useLoaderData();
		const { user, i18n } = rootApi.useLoaderData();
		const entry = findPage(appPages, pagePath(_splat));
		if (entry === undefined) return null;
		return createElement(entry.page.component, {
			data,
			ctx: {
				plugins: enabledPlugins(plugins, enabledIdSet(pluginStates)),
				locale: i18n?.locale ?? "en",
				user,
				i18n,
				pluginStates,
			},
		});
	},
});
