import * as Effect from "effect/Effect";

import { requirePluginEnabled } from "./plugin-route.ts";
import { runAs } from "./runtime.ts";
import {
	ensureDoctorUser,
	ensureSessionUser,
	getDoctorUser,
	getSessionUser,
	type ActingUser,
	type SessionUser,
} from "./session.ts";

/**
 * Server-fn handler wrappers (the shared preamble every plugin `fns.ts`
 * repeated inline):
 *
 *   export const listThingsFn = createServerFn ({ method: "POST" })
 *   	.validator((input: unknown) => decodeList(input))
 *   	.handler(
 *  		sessionHandler(async ({ data, run }) =>
 *  			run(Effect.gen(function* () { ... })),
 *  		),
 *   );
 *
 * The wrappers inject `user` (the acting principal) and `run` —
 * `runAs(user, effect)` with the tenant selector left to the runtime's
 * default header extraction, which is exactly what the hand-written
 * `runAs(user, effect)` / `runAs(user, effect, await getTenantSelector())`
 * pairs resolved to. `pluginHandler` prepends the plugin enablement
 * gate (`requirePluginEnabled`) ahead of the session check, matching
 * the established order.
 *
 * IMPORTANT: these are handler ARGUMENTS, not server-fn factories. The
 * Start compiler only recognises literal top-level
 * `export const x = createServerFn (…)` chains (see
 * apps/web `server-fn-shape.test.ts`), so `createServerFn` itself must
 * stay at each call site — the wrappers collapse what goes INSIDE
 * `.handler(...)`, nothing else.
 */

/** Effect runner bound to the request's acting user. */
export type BoundRun = <A, E>(effect: Effect.Effect<A, E, unknown>) => Promise<A>;

/** Arguments injected into wrapped handlers on top of the wire `data`. */
export interface ServerFnHandlerContext<U> {
	/** The acting principal: the session user, or the doctor-acting
	 * {@link ActingUser} for doctor-scoped fns. */
	readonly user: U;
	/** `runAs(user, effect)` — principal + tenant selector bound. */
	readonly run: BoundRun;
}

const bindRun =
	(user: { readonly id: string; readonly email?: string; readonly actorId?: string }): BoundRun =>
	(effect) =>
		runAs(user, effect);

const withContext = <Args extends object, U extends SessionFnUser>(
	args: Args,
	user: U,
): Args & ServerFnHandlerContext<U> => ({
	...args,
	user,
	run: bindRun(user),
});

type SessionFnUser = Pick<SessionUser, "id" | "email"> & { readonly actorId?: string };

/**
 * Session-gated handler: anonymous callers get `UnauthenticatedError`
 * (401, same as the inline `ensureSessionUser()` preamble); signed-in
 * callers receive `{ ...args, user, run }`.
 */
export const sessionHandler =
	<Args extends object, R>(
		fn: (args: Args & ServerFnHandlerContext<SessionUser>) => Promise<R>,
	): ((args: Args) => Promise<R>) =>
	async (args) => {
		const user = await ensureSessionUser();
		return fn(withContext(args, user));
	};

/**
 * Doctor-gated handler: like {@link sessionHandler} but requires a
 * doctor profile to act as — anonymous → 401, signed-in without a
 * doctor profile → `NotADoctorError` (403), exactly the inline
 * `ensureDoctorUser()` contract. `user` is the {@link ActingUser} whose
 * `id`/`actorId` the doctor-scoped services expect.
 */
export const doctorHandler =
	<Args extends object, R>(
		fn: (args: Args & ServerFnHandlerContext<ActingUser>) => Promise<R>,
	): ((args: Args) => Promise<R>) =>
	async (args) => {
		const user = await ensureDoctorUser();
		return fn(withContext(args, user));
	};

/**
 * Fail-closed session handler for read paths that answer anonymous
 * callers with an empty result instead of a 401: `onAnonymous` runs
 * when there is no session (its return becomes the wire result),
 * otherwise the handler gets the same `{ ...args, user, run }` context
 * as {@link sessionHandler}.
 */
export const optionalSessionHandler =
	<Args extends object, R>(
		onAnonymous: (args: Args) => R | Promise<R>,
		fn: (args: Args & ServerFnHandlerContext<SessionUser>) => Promise<R>,
	): ((args: Args) => Promise<R>) =>
	async (args) => {
		const user = await getSessionUser();
		if (user === null) return onAnonymous(args);
		return fn(withContext(args, user));
	};

/**
 * Fail-closed doctor handler — the {@link getDoctorUser} counterpart of
 * {@link optionalSessionHandler}: no session OR no doctor profile to
 * act as both collapse to `onAnonymous` (doctor data paths treat
 * "nothing visible" identically for both cases).
 */
export const optionalDoctorHandler =
	<Args extends object, R>(
		onAnonymous: (args: Args) => R | Promise<R>,
		fn: (args: Args & ServerFnHandlerContext<ActingUser>) => Promise<R>,
	): ((args: Args) => Promise<R>) =>
	async (args) => {
		const user = await getDoctorUser();
		if (user === null) return onAnonymous(args);
		return fn(withContext(args, user));
	};

/**
 * Plugin enablement gate prepended to any handler: runs
 * `requirePluginEnabled(pluginId)` before delegating, so a disabled
 * plugin's fns fail with `PluginDisabledError` instead of serving —
 * the same first-statement contract the inline
 * `await requirePluginEnabled(...)` preamble enforced. Composes with
 * the session wrappers: `pluginHandler("x.y", sessionHandler(fn))`
 * keeps the established gate-then-auth order.
 */
export const pluginHandler =
	<Args extends object, R>(
		pluginId: string,
		fn: (args: Args) => Promise<R>,
	): ((args: Args) => Promise<R>) =>
	async (args) => {
		await requirePluginEnabled(pluginId);
		return fn(args);
	};

/**
 * Collapse a service-layer `Forbidden` denial into `fallback` — the
 * standard "not visible" outcome plugin fns return for unauthorized
 * reads/writes (`null`, `{ ok: false }`, an empty list/page). Only the
 * `Forbidden` tag is caught; `TenantForbidden`, domain errors and
 * defects still propagate — call sites that handled more tags keep
 * their own `catchTags`.
 *
 *   .pipe(forbiddenTo({ ok: false as const }))
 */
export const forbiddenTo =
	<F>(fallback: F) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | F, E, R> =>
		Effect.catchIf(
			effect,
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				(error as { readonly _tag?: unknown })._tag === "Forbidden",
			() => Effect.succeed(fallback),
		);

/**
 * Mock-side rebuild of the wrappers above, for `vi.mock("@ktb/server-fns")`
 * factories. The real wrappers resolve the auth primitives through
 * relative imports a module mock cannot intercept, so a test that stubs
 * `ensureSessionUser`/`runAs`/… needs the wrappers rebuilt on top of the
 * mock itself. Each returned wrapper resolves the mocked module lazily at
 * call time — `import("@ktb/server-fns")` inside a running test resolves
 * to the mock — so it picks up whichever primitives the factory provides.
 * Take it from the `importOriginal` result and spread it last:
 *
 *   vi.mock("@ktb/server-fns", async (importOriginal) => {
 *   	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
 *   	return { ...actual, ensureSessionUser: mocks.user, ...actual.serverFnHandlerMocks() };
 *   });
 */
export const serverFnHandlerMocks = () => {
	type User = { readonly id: string; readonly email?: string; readonly actorId?: string };
	type Module = {
		ensureSessionUser(): Promise<User>;
		ensureDoctorUser(): Promise<User>;
		getSessionUser(): Promise<User | null>;
		getDoctorUser(): Promise<User | null>;
		requirePluginEnabled(pluginId: string): Promise<unknown>;
		runAs(user: User, effect: unknown): Promise<unknown>;
	};
	const primitives = () => import("@ktb/server-fns") as unknown as Promise<Module>;
	// Same injection contract as the wrappers above: `{ ...args, user, run }`
	// where `run` is `runAs(user, effect)`.
	const context = (user: User, m: Module, args: object) => ({
		...args,
		user,
		run: (effect: unknown) => m.runAs(user, effect),
	});
	return {
		sessionHandler:
			<Args extends object, R>(fn: (args: Args) => Promise<R>) =>
			async (args: Args): Promise<R> => {
				const m = await primitives();
				return fn(context(await m.ensureSessionUser(), m, args) as Args);
			},
		doctorHandler:
			<Args extends object, R>(fn: (args: Args) => Promise<R>) =>
			async (args: Args): Promise<R> => {
				const m = await primitives();
				return fn(context(await m.ensureDoctorUser(), m, args) as Args);
			},
		optionalSessionHandler:
			<Args extends object, R>(
				onAnonymous: (args: Args) => R | Promise<R>,
				fn: (args: Args) => Promise<R>,
			) =>
			async (args: Args): Promise<R> => {
				const m = await primitives();
				const user = await m.getSessionUser();
				if (user === null) return onAnonymous(args);
				return fn(context(user, m, args) as Args);
			},
		optionalDoctorHandler:
			<Args extends object, R>(
				onAnonymous: (args: Args) => R | Promise<R>,
				fn: (args: Args) => Promise<R>,
			) =>
			async (args: Args): Promise<R> => {
				const m = await primitives();
				const user = await m.getDoctorUser();
				if (user === null) return onAnonymous(args);
				return fn(context(user, m, args) as Args);
			},
		pluginHandler:
			<Args extends object, R>(pluginId: string, fn: (args: Args) => Promise<R>) =>
			async (args: Args): Promise<R> => {
				const m = await primitives();
				await m.requirePluginEnabled(pluginId);
				return fn(args);
			},
	};
};
