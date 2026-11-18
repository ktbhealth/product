import { describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

import type * as Effect from "effect/Effect";

import type { ThemePublishInput } from "./theme.ts";
import type { ThemeSummary } from "./types.ts";

/**
 * The `@tanstack/react-start/server` cookie module is unavailable in
 * this environment — `cookieApi()` must degrade to null so server fns
 * stay loadable outside a request context (tests, build).
 */
vi.mock("@tanstack/react-start", () => reactStartMock());

vi.mock("@tanstack/react-start/server", () => {
	throw new Error("react-start server unavailable in this test env");
});

// Session/runtime boundary stubbed: getSessionUser/ensureSessionUser
// resolve an admin user directly (the real ones would need the
// unavailable server module for request headers), and run/runAs
// execute the effect against inline service stubs.
vi.mock("@ktb/server-fns", async () => {
	const Effect = await import("effect/Effect");
	const { Principal } = await import("@ktb/authz");
	const { PlatformAdmin } = await import("@ktb/platform");
	const { Theme } = await import("./theme.ts");
	const { KTB_DEFAULT_THEME } = await import("./default-theme.ts");

	const themeStub = Theme.of({
		resolve: () => Effect.succeed(KTB_DEFAULT_THEME),
		list: () => Effect.succeed([]),
		get: () => Effect.succeed(null),
		publish: (input: ThemePublishInput) =>
			Effect.succeed({
				id: 1,
				scope: input.scope as ThemeSummary["scope"],
				scopeId: input.scopeId,
				appName: null,
				enabled: true,
				version: 1,
			}),
		setEnabled: () => Effect.void,
		previewRow: () => Effect.succeed(null),
	});
	const adminGate = {
		isAdmin: () => Effect.succeed(true),
		requireAdmin: () => Effect.void,
	};
	const provide = <A, E>(
		effect: Effect.Effect<A, E, never>,
		user?: { id: string; email: string },
	) => {
		const provided = effect.pipe(
			Effect.provideService(Theme, themeStub),
			Effect.provideService(PlatformAdmin, adminGate as never),
		);
		return user === undefined
			? provided
			: provided.pipe(
					Effect.provideService(Principal, {
						userId: user.id,
						email: user.email,
					}),
				);
	};
	const user = { id: "u-admin", email: "admin@x.com" };
	return {
		run: (effect: Effect.Effect<unknown, unknown, never>) =>
			Effect.runPromise(provide(effect as never)),
		runAs: (u: { id: string; email?: string }, effect: Effect.Effect<unknown, unknown, never>) =>
			Effect.runPromise(provide(effect as never, { id: u.id, email: u.email ?? "" })),
		getSessionUser: async () => user,
		ensureSessionUser: async () => user,
	};
});

import { setThemePreviewFn, themeScopeFn } from "./fns.ts";

describe("server fns without the react-start server module", () => {
	it("themeScopeFn resolves normally when the cookie API is unavailable", async () => {
		const theme = await themeScopeFn({ data: { scope: "session" } });
		expect(theme?.id).toBe(0);
		expect(theme?.preview).toBeUndefined();
	});

	it("setThemePreviewFn reports ok:false instead of throwing", async () => {
		expect(await setThemePreviewFn({ data: { themeId: 3 } })).toEqual({
			ok: false,
		});
	});
});
