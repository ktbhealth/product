import { Auth, type AuthShape, type Session } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import * as Effect from "effect/Effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";

import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "./runtime.ts";

/**
 * Shared harness for plugin `fns.test.ts` suites (T-149): every plugin
 * server-fn test needs the same three pieces — a `createServerFn` chain
 * stub, fresh per-call request `Headers`, and a `ServerRuntime` whose
 * `run`/`runAs` provide `Auth`/`Principal` over a `ManagedRuntime`.
 * Keeping them here stops each plugin test from re-declaring ~60 lines
 * of identical `vi.mock` + `setServerRuntime` scaffolding.
 *
 * Usage (the mock factories are module-level so `vi.mock` can register
 * them before the test module body runs — do NOT wrap them in a local
 * `const harness = …`, the factory would hit the TDZ):
 *
 *   import {
 *   	installServerFnRuntime,
 *   	reactStartMock,
 *   	reactStartServerMock,
 *   	resetServerFnRuntime,
 *   	sessionUser,
 *   	stubAuth,
 *   } from "@ktb/server-fns/testing";
 *
 *   vi.mock("@tanstack/react-start/server", reactStartServerMock);
 *   vi.mock("@tanstack/react-start", reactStartMock);
 *
 *   // …later, once the plugin's ManagedRuntime exists:
 *   installServerFnRuntime(runtime, stubAuth(() => sessionUser(currentEmail)));
 */

interface ServerFnChain {
	validator(v: (x: unknown) => unknown): ServerFnChain;
	handler(h: (arg?: { data?: unknown }) => unknown): (arg?: { data?: unknown }) => Promise<unknown>;
}

/**
 * `createServerFn` stub matching the real `.validator(…).handler(…)`
 * chain: the validator runs on `arg?.data` before the handler sees it —
 * including when the fn is invoked with no arg at all, mirroring how
 * production decodes `undefined` input.
 */
const createServerFnStub = (options?: Record<string, unknown>): ServerFnChain => {
	let validate: ((x: unknown) => unknown) | undefined;
	const chain: ServerFnChain = {
		validator: (v) => {
			validate = v;
			return chain;
		},
		handler: (h) => {
			const call = async (arg?: { data?: unknown }) =>
				// The validator always runs — even on a missing arg — so
				// `fn()` decodes `undefined` exactly like production.
				h({
					...(arg ?? {}),
					data: validate === undefined ? arg?.data : validate(arg?.data),
				});
			// Real server fns expose their createServerFn options (e.g.
			// `.method`) on the callable — tests assert on them.
			return Object.assign(call, options ?? {});
		},
	};
	return chain;
};

/**
 * Mutable per-"request" headers backing {@link reactStartServerMock}.
 * Tests that need request headers set `serverFnRequestHeaders.current =
 * new Headers({ … })`; `getRequestHeaders` always returns a FRESH
 * `Headers` copy because `@ktb/server-fns` memoizes session lookups per
 * request keyed on the `Headers` identity — reusing one object would
 * leak the previous case's session into the next.
 */
export const serverFnRequestHeaders = { current: new Headers() };

/** `vi.mock("@tanstack/react-start", …)` factory. */
export const reactStartMock = (): { createServerFn: typeof createServerFnStub } => ({
	createServerFn: createServerFnStub,
});

/** `vi.mock("@tanstack/react-start/server", …)` factory. */
export const reactStartServerMock = (): { getRequestHeaders: () => Headers } => ({
	getRequestHeaders: () => new Headers(serverFnRequestHeaders.current),
});

/**
 * Session fixture: `email === null` means anonymous; otherwise a
 * minimal authenticated `Session` whose user id derives from the email
 * (same convention the plugin tests used inline).
 */
export const sessionUser = (email: string | null): Session | null =>
	email === null
		? null
		: {
				user: { id: `id-${email}`, email, name: email },
				sessionId: "s1",
				expiresAt: new Date(Date.now() + 3600_000),
			};

/**
 * `Auth` shape stub backed by a reader — typically
 * `stubAuth(() => sessionUser(currentEmail))` where `currentEmail` is a
 * `let` the test mutates between cases. `setUserBanned` is a no-op.
 */
export const stubAuth = (read: () => Session | null | Promise<Session | null>): AuthShape => ({
	getSession: async () => read(),
	setUserBanned: async () => {},
});

/**
 * Register a `ServerRuntime` for the duration of a test: `run` provides
 * the stub `Auth`, `runAs` provides the `Principal` (plus optional
 * `actorId`), locale is `"en"` and `audioTranscribeModel` a fixed test
 * value. `overrides` merges last so a test can wire extra capabilities
 * — e.g. `{ pluginEnabled: async () => false }` for the enablement
 * gate (T-149).
 *
 * Pair with `resetServerFnRuntime()` in `afterAll`.
 */
export const installServerFnRuntime = <R, E>(
	runtime: ManagedRuntime.ManagedRuntime<R, E>,
	auth: AuthShape,
	overrides: Partial<ServerRuntime> = {},
): void => {
	// ManagedRuntime is invariant in its service set — widen once so any
	// composed runtime is accepted; the effects below only require the
	// services the runtime itself provides.
	const rt = runtime as unknown as ManagedRuntime.ManagedRuntime<unknown, never>;
	// defineProperties (not a spread) so accessor overrides stay lazy —
	// e.g. a test's `get jobs()` flag probe must re-read on every
	// `getServerRuntime()` access, not freeze at install time.
	setServerRuntime(
		Object.defineProperties(
			{
				run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
					rt.runPromise(effect.pipe(Effect.provideService(Auth, auth))),
				runAs: <A, E>(
					user: { readonly id: string; readonly email?: string; readonly actorId?: string },
					effect: Effect.Effect<A, E, unknown>,
				) =>
					rt.runPromise(
						effect.pipe(
							Effect.provideService(Principal, {
								userId: user.id,
								email: user.email,
								actorId: user.actorId,
							}),
						),
					),
				audioTranscribeModel: "test-model",
				getLocale: () => "en",
			} satisfies ServerRuntime,
			Object.getOwnPropertyDescriptors(overrides),
		),
	);
};

/** Drop the registered runtime — convenience wrapper for `afterAll`. */
export const resetServerFnRuntime = (): void => {
	resetServerRuntime();
};
