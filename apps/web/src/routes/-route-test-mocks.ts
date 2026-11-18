import { createElement, type ReactNode } from "react";

/**
 * Shared `vi.mock` factories for bare route-component tests — no router
 * context exists, so `Link` renders as a plain anchor and
 * `createFileRoute` only keeps the route's options reachable for direct
 * assertions (`options.head/loader/component`). Mocking stays
 * file-local: each test file calls `vi.mock` itself and delegates the
 * factory, e.g.
 *
 *   vi.mock("@tanstack/react-router", (importOriginal) =>
 *       import("./-route-test-mocks.ts").then((m) => m.routerMock(importOriginal)));
 *   vi.mock("#/lib/i18n.ts", (importOriginal) =>
 *       import("./-route-test-mocks.ts").then((m) => m.i18nMock(importOriginal)));
 */

/** `@tanstack/react-router` mock. `extra` merges into both the route
 * object and the module namespace — e.g. a controllable
 * `useLoaderData`. */
export const routerMock = async (
	importOriginal: () => Promise<typeof import("@tanstack/react-router")>,
	extra: Record<string, unknown> = {},
) => {
	const actual = await importOriginal();
	return {
		...actual,
		Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
			createElement("a", { href: to, ...props }, children),
		createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts, ...extra }),
		...extra,
	};
};

/** `#/lib/i18n.ts` mock: no root slice, so copy falls back to the
 * English baseline. Pass a `{ current }` ref as `missingKey` to make
 * one catalog key miss per test — the page's raw-key fallback branch
 * then runs. */
export const i18nMock = async (
	importOriginal: () => Promise<typeof import("#/lib/i18n.ts")>,
	missingKey?: { current: string | null },
) => {
	const actual = await importOriginal();
	return {
		...actual,
		useRootI18nSlice: () => undefined,
		appCatalogT: (slice: Parameters<typeof actual.appCatalogT>[0]) => {
			const t = actual.appCatalogT(slice);
			return (key: string, params?: Record<string, unknown>) =>
				key === missingKey?.current ? key : t(key, params);
		},
	};
};
