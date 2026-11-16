import { describe, expect, it, vi } from "vitest";

// i18nRouteFn edge coverage: failure isolation (H3 — the root loader
// runs this fn on EVERY route, so a broken i18n store must degrade to
// the base-locale slice, not 500) and portal-scope gating (L2 — an
// unregistered /portal/<seg> must not reach portal-scoped rows).
const hoisted = vi.hoisted(() => ({
	failLocales: false,
	scopeChains: [] as { scopes: readonly { scope: string; scopeId: string }[] }[],
}));

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => new Headers(),
}));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const chain = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return chain;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (arg?: { data?: unknown }) =>
				h(arg === undefined ? {} : { ...arg, data: validate ? validate(arg.data) : arg.data }),
		};
		return chain;
	},
}));
vi.mock("@ktb/i18n-plugin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/i18n-plugin")>();
	return {
		...actual,
		listEnabledLocales: (...args: Parameters<typeof actual.listEnabledLocales>) =>
			hoisted.failLocales
				? Promise.reject(new Error("i18n_locales unavailable"))
				: actual.listEnabledLocales(...args),
		catalogSlice: (
			db: Parameters<typeof actual.catalogSlice>[0],
			input: Parameters<typeof actual.catalogSlice>[1],
		) => {
			hoisted.scopeChains.push(input.scopeChain);
			return actual.catalogSlice(db, input);
		},
	};
});

import { i18nRouteFn } from "./fns.ts";

describe("i18nRouteFn failure isolation", () => {
	it("degrades to the empty base-locale slice when i18n resolution fails", async () => {
		hoisted.failLocales = true;
		try {
			const res = await i18nRouteFn({ data: "/consultations" });
			expect(res).toEqual({
				locale: "en",
				locales: ["en"],
				enabledLocales: ["en"],
				namespaces: [],
				catalog: {},
			});
		} finally {
			hoisted.failLocales = false;
		}
	});
});

describe("i18nRouteFn portal scope gating", () => {
	it("scopes copy to a registered portal instance", async () => {
		hoisted.scopeChains.length = 0;
		const res = await i18nRouteFn({ data: "/portal/clinician" });
		expect(res.locale).toBeTruthy();
		expect(hoisted.scopeChains).toHaveLength(1);
		expect(hoisted.scopeChains[0]!.scopes[0]).toEqual({
			scope: "portal",
			scopeId: "clinician",
		});
	});

	it("falls through to global scope for an unregistered /portal/<seg>", async () => {
		hoisted.scopeChains.length = 0;
		const res = await i18nRouteFn({ data: "/portal/not-a-real-instance" });
		expect(res.locale).toBeTruthy();
		expect(hoisted.scopeChains).toHaveLength(1);
		expect(hoisted.scopeChains[0]!.scopes.every((s) => s.scope !== "portal")).toBe(true);
	});
});
