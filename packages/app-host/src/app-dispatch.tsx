import { createElement, type ComponentType } from "react";
import { notFound, redirect } from "@tanstack/react-router";

import type { ChromeUser, PageI18nSlice, Plugin } from "@ktb/kernel";

import type { PageDataResult } from "./dispatch.ts";
import { findPage, type PageEntry } from "./pages.ts";
import {
	enabledIdSet,
	enabledPlugins,
	entryEnabled,
	type PluginStatesResult,
} from "./plugin-state.ts";

/**
 * App-shell page dispatch (P-059): plugins declare `pages` descriptors
 * keyed by absolute path; `findPage` resolves exact descriptors first,
 * then "/*" wildcards by longest base. Unknown paths 404; a disabled
 * owning plugin or a `guard` denial 404s the same way. App pages may
 * be PUBLIC — the page-data server fn runs the loader Effect without
 * a bound Principal when nobody is signed in.
 *
 * Everything app-bound is injected: the server fns (`pluginStates`,
 * `pageData`), the i18n slice extractor for `head()` matches, the root
 * loader-data hook, and the registrIES (client `plugins` + `appPages`).
 * `createAppDispatch` returns the route hooks/components the host's
 * splat route wires in.
 */

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
): { pathname: string; searchStr: string; href: string } => {
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

/** Root loader data the AppPage component context reads. */
export interface AppRootLoaderData {
	readonly user?: ChromeUser | null;
	readonly i18n?: PageI18nSlice;
}

export interface AppDispatchDeps {
	/** Discovered client plugin registry (enabled-filtered view is
	 * derived per render from `pluginStates`). */
	readonly plugins: readonly Plugin[];
	/** App-shell page map (client registry `appPages`). */
	readonly appPages: ReadonlyMap<string, PageEntry>;
	/** `pluginStatesFn` — enabled plugin ids for chrome gating. */
	readonly pluginStates: () => Promise<PluginStatesResult>;
	/** `appPageDataFn` — the page-data server fn. */
	readonly pageData: (input: {
		readonly data: { readonly path: string; readonly search?: Record<string, unknown> };
	}) => Promise<PageDataResult>;
	/** i18n slice extractor for `head()` match chains (the host's
	 * root-match loaderData reader). */
	readonly i18nSlice: (
		matches: ReadonlyArray<{ routeId?: unknown; loaderData?: unknown }> | undefined,
	) => PageI18nSlice | undefined;
	/** Root route loader-data hook — called inside AppPage render. */
	readonly useRootData: () => AppRootLoaderData;
}

export interface AppLoaderData {
	data: unknown;
	pluginStates: PluginStatesResult;
}

export interface AppDispatch {
	// `any` (not `unknown`): the hook result becomes route context —
	// TanStack's beforeLoad signature accepts whatever the page hook
	// returned, same as the pre-extraction `as never` cast allowed.
	readonly appBeforeLoad: (args: {
		params: { _splat?: string } & Record<string, unknown>;
		search: unknown;
		location: { pathname: string; searchStr: string; href: string };
		context: unknown;
	}) => Promise<any>;
	readonly appLoader: (args: {
		params: { _splat?: string } & Record<string, unknown>;
		deps: { search?: unknown };
	}) => Promise<AppLoaderData>;
	readonly appHead: (ctx: {
		params: { _splat?: string } & Record<string, unknown>;
		match?: { search?: unknown; pathname?: string };
		loaderData?: unknown;
		matches?: ReadonlyArray<{ routeId?: unknown; loaderData?: unknown }>;
	}) => unknown;
	readonly AppPage: ComponentType<{ path: string; loaderData: AppLoaderData }>;
}

export const createAppDispatch = (deps: AppDispatchDeps): AppDispatch => {
	const appBeforeLoad = async ({
		params,
		search,
		location,
		context,
	}: {
		params: { _splat?: string } & Record<string, unknown>;
		search: unknown;
		location: { pathname: string; searchStr: string; href: string };
		context: unknown;
	}) => {
		const path = pagePath(params._splat);
		const entry = findPage(deps.appPages, path);
		const hook = entry?.page.beforeLoad;
		if (entry === undefined || hook === undefined) return;
		// Enablement gate (P-058) runs BEFORE the page hook — the same
		// contract appLoader and the server-side pageData middleware
		// stages enforce: a disabled plugin's beforeLoad (redirects,
		// notFound, side effects) must not execute. pluginStates is a
		// GET server fn whose handler is TTL-cached server-side, so the
		// repeat call in appLoader — and the root loader's — stays cheap.
		const states = await deps.pluginStates();
		if (!entryEnabled(deps.plugins, enabledIdSet(states), entry)) throw notFound();
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

	const appLoader = async ({
		params,
		deps: loaderDeps,
	}: {
		params: { _splat?: string } & Record<string, unknown>;
		deps: { search?: unknown };
	}) => {
		const path = pagePath(params._splat);
		const entry = findPage(deps.appPages, path);
		if (entry === undefined) throw notFound();
		const states = await deps.pluginStates();
		if (!entryEnabled(deps.plugins, enabledIdSet(states), entry)) throw notFound();
		const hasSearch = loaderDeps.search !== undefined;
		let search: Readonly<Record<string, unknown>> | undefined;
		if (hasSearch) {
			const parsed = hookSearch(loaderDeps.search);
			search =
				entry.page.validateSearch?.({
					search: parsed,
					path,
					params: hookParams(params),
				}) ?? parsed;
		}
		const result = await deps.pageData({ data: { path, search } });
		if (result.status === "notfound") throw notFound();
		if (result.status === "redirect") throw redirect({ href: result.to });
		return { data: result.data, pluginStates: states };
	};

	const appHead = (ctx: {
		params: { _splat?: string } & Record<string, unknown>;
		match?: { search?: unknown; pathname?: string };
		loaderData?: unknown;
		matches?: ReadonlyArray<{ routeId?: unknown; loaderData?: unknown }>;
	}): unknown => {
		const path = pagePath(ctx.params._splat);
		const entry = findPage(deps.appPages, path);
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
				i18n: deps.i18nSlice(ctx.matches),
			}) ?? {}
		);
	};

	const AppPage = ({ path, loaderData }: { path: string; loaderData: AppLoaderData }) => {
		const { user, i18n } = deps.useRootData();
		const entry = findPage(deps.appPages, path);
		if (entry === undefined) return null;
		return createElement(entry.page.component, {
			data: loaderData.data,
			ctx: {
				plugins: enabledPlugins(deps.plugins, enabledIdSet(loaderData.pluginStates)),
				locale: i18n?.locale ?? "en",
				user,
				i18n,
				pluginStates: loaderData.pluginStates,
			},
		});
	};

	return { appBeforeLoad, appLoader, appHead, AppPage };
};
