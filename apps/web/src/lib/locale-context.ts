import type { AsyncLocalStorage } from "node:async_hooks";

import { BASE_LOCALE } from "./i18n.ts";

/**
 * Request-scoped UI locale (PL-008 Phase 5 — replaces paraglide's
 * AsyncLocalStorage). start.ts middleware runs every request inside
 * `als.run({ locale })`, so deep server code (email copy, server fns,
 * plugin services) resolves the active locale without threading it
 * through every signature. Outside a request (tests, build, client
 * bundle) `currentLocale()` returns the base locale.
 *
 * The ALS instance is a lazily-created SINGLETON: `node:async_hooks`
 * is only importable on the server, so this module stays isomorphic,
 * and a per-request instance would race — whichever request ran the
 * middleware last would own the module global, and earlier requests'
 * continuations would read an empty store (base locale) mid-flight.
 */
let storage: AsyncLocalStorage<{ locale: string }> | undefined;
let storagePromise: Promise<AsyncLocalStorage<{ locale: string }>> | undefined;

/** Server-only: the shared ALS, created once on first request. */
export const localeStorage = (): Promise<AsyncLocalStorage<{ locale: string }>> => {
	storagePromise ??= import("node:async_hooks").then((m) => {
		storage = new m.AsyncLocalStorage<{ locale: string }>();
		return storage;
	});
	return storagePromise;
};

export const currentLocale = (): string => storage?.getStore()?.locale ?? BASE_LOCALE;
