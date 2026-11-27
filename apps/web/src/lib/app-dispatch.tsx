import { getRouteApi } from "@tanstack/react-router";

import { createAppDispatch, type AppRootLoaderData } from "@ktb/app-host/client";

import { appPageDataFn, pluginStatesFn } from "#/lib/fns.ts";
import { i18nSliceFromHeadMatches } from "#/lib/i18n.ts";
import { appPages } from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";

/**
 * App-shell page dispatch (P-059) — the generic dispatcher lives in
 * @ktb/app-host/client (`createAppDispatch`); this module binds it to
 * the app's server fns, i18n slice extractor, root loader data and
 * registries.
 */

const rootApi = getRouteApi("__root__");

const dispatch = createAppDispatch({
	plugins,
	appPages,
	pluginStates: () => pluginStatesFn(),
	pageData: (input) => appPageDataFn(input),
	i18nSlice: i18nSliceFromHeadMatches,
	useRootData: () => rootApi.useLoaderData() as AppRootLoaderData,
});

export const appBeforeLoad = dispatch.appBeforeLoad;
export const appLoader = dispatch.appLoader;
export const appHead = dispatch.appHead;
export const AppPage = dispatch.AppPage;
export type { AppLoaderData } from "@ktb/app-host/client";
