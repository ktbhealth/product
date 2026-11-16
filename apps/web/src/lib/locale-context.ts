import type { AsyncLocalStorage } from "node:async_hooks";

import { BASE_LOCALE } from "./i18n.ts";

/**
 * Request-scoped UI locale (PL-008 Phase 5 — replaces paraglide's
 * AsyncLocalStorage). start.ts middleware runs every request inside
 * `runWithLocale(requestLocale(request))`, so deep server code (email
 * copy, server fns, plugin services) resolves the active locale without
 * threading it through every signature. Outside a request (tests,
 * build, client bundle) `currentLocale()` returns the base locale.
 *
 * The ALS instance is injected by the server middleware — `node:async_hooks`
 * is only importable on the server, so this module stays isomorphic.
 */
let storage: AsyncLocalStorage<{ locale: string }> | undefined;

export const setLocaleStorage = (als: AsyncLocalStorage<{ locale: string }>): void => {
	storage = als;
};

export const runWithLocale = <T>(locale: string, fn: () => T): T =>
	storage === undefined ? fn() : storage.run({ locale }, fn);

export const currentLocale = (): string => storage?.getStore()?.locale ?? BASE_LOCALE;
