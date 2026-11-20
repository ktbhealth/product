import { createElement } from "react";
import { getRouteApi, notFound, redirect } from "@tanstack/react-router";

import { appPageDataFn, pluginStatesFn } from "#/lib/fns.ts";
import { i18nSliceFromHeadMatches } from "#/lib/i18n.ts";
import { appPages, enabledIdSet, enabledPlugins, entryEnabled, findPage } from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";
import type { PageHookContext } from "@ktb/kernel";

const rootApi = getRouteApi("__root__");

const pagePath = (splat: string | undefined): string => `/${splat ?? ""}`;

const hookParams = (params: unknown): Readonly<Record<string, string | undefined>> =>
	params as Readonly<Record<string, string | undefined>>;

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

/**
 * App-shell page dispatch (P-059): plugins declare `pages`
 * descriptors keyed by absolute path; `findPage` resolves exact
 * descriptors first, then "/*" wildcards by longest base. Unknown
 * paths 404; a disabled owning plugin or a `guard` denial 404s the
 * same way. App pages may be PUBLIC — `appPageDataFn` runs the loader
 * Effect without a bound Principal when nobody is signed in.
 * `ctx.plugins` is the enabled-filtered client registry (P-058),
 * `ctx.user` the session user or null, `ctx.pluginStates` the raw
 * enablement snapshot plugin chrome gates (login tiles) check against.
 */

interface AppBeforeLoadArgs {
	params: { _splat?: string } & Record<string, unknown>;
	search: unknown;
	location: { pathname: string; searchStr: string; href: string };
	context: unknown;
}

export const appBeforeLoad = async ({ params, search, location, context }: AppBeforeLoadArgs) => {
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
};

interface AppLoaderArgs {
	params: { _splat?: string } & Record<string, unknown>;
	deps: { search?: unknown };
}

export const appLoader = async ({ params, deps }: AppLoaderArgs) => {
	const path = pagePath(params._splat);
	const entry = findPage(appPages, path);
	if (entry === undefined) throw notFound();
	const states = await pluginStatesFn();
	if (!entryEnabled(plugins, enabledIdSet(states), entry)) throw notFound();
	const hasSearch = deps.search !== undefined;
	let search: Readonly<Record<string, unknown>> | undefined;
	if (hasSearch) {
		const parsed = hookSearch(deps.search);
		search =
			entry.page.validateSearch?.({
				search: parsed,
				path,
				params: hookParams(params),
			}) ?? parsed;
	}
	const result = await appPageDataFn({ data: { path, search } });
	if (result.status === "notfound") throw notFound();
	if (result.status === "redirect") throw redirect({ href: result.to });
	return { data: result.data, pluginStates: states };
};

export const appHead = (ctx: {
	params: { _splat?: string } & Record<string, unknown>;
	match?: { search?: unknown; pathname?: string };
	loaderData?: unknown;
	matches?: ReadonlyArray<{ routeId?: unknown; loaderData?: unknown }>;
}): unknown => {
	const path = pagePath(ctx.params._splat);
	const entry = findPage(appPages, path);
	const hook = entry?.page.head;
	if (hook === undefined) return {};
	const search = hookSearch(ctx.match?.search);
	const pathname = ctx.match?.pathname ?? path;
	return (
		hook({
			path,
			params: hookParams(ctx.params),
			search,
			location: headLocation(pathname, search),
			loaderData: ctx.loaderData,
			matches: ctx.matches,
			i18n: i18nSliceFromHeadMatches(ctx.matches),
		}) ?? {}
	);
};

export interface AppLoaderData {
	data: unknown;
	pluginStates: { enabled: readonly string[] };
}

export function AppPage({ path, loaderData }: { path: string; loaderData: AppLoaderData }) {
	const { user, i18n } = rootApi.useLoaderData();
	const entry = findPage(appPages, path);
	if (entry === undefined) return null;
	return createElement(entry.page.component, {
		data: loaderData.data,
		ctx: {
			plugins: enabledPlugins(plugins, enabledIdSet(loaderData.pluginStates)),
			locale: i18n?.locale ?? "en",
			user,
			i18n,
			pluginStates: loaderData.pluginStates,
		},
	});
}
