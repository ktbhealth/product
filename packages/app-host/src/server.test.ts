import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import {
	middlewareContinue,
	middlewareDeny,
	middlewareRedirect,
	type MiddlewareContext,
	type MiddlewareStage,
	type Plugin,
} from "@ktb/kernel";
import { PluginStates } from "@ktb/platform/plugin-states";

import {
	cachedEnabledIds,
	collectServerPages,
	dispatchPage,
	makePageMiddlewareRunner,
	type PageDispatchDeps,
	type PageMiddlewareRunnerDeps,
} from "./server.ts";
import type { PageEntry } from "./pages.ts";

// The runner/dispatch deps are plain values — tests supply fake
// registries, a controllable enabled-id Effect and run/runAs that
// execute Effects with a stub PluginStates, mirroring how apps/web
// binds them to its runtime.

const states = (enabled: ReadonlySet<string>) => ({
	isEnabled: (id: string) => Effect.succeed(enabled.has(id)),
	enabledIds: () => Effect.succeed(enabled),
	config: () => Effect.succeed(undefined),
	setEnabled: () => Effect.void,
	setConfig: () => Effect.void,
	entries: () => Effect.succeed([]),
});

const makeRun = (enabled: ReadonlySet<string>) => {
	const runEffect = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
		Effect.runPromise(
			(effect as Effect.Effect<A, E, never>).pipe(
				Effect.provideService(PluginStates, states(enabled) as never),
			),
		);
	return {
		run: runEffect,
		runAs: <A, E>(_user: { id: string }, effect: Effect.Effect<A, E, unknown>) => runEffect(effect),
	};
};

const stage = (id: string, order = 50): MiddlewareStage => ({
	id,
	order,
	handler: () =>
		Effect.sync(() => {
			calls.push(id);
			return middlewareContinue();
		}),
});

const calls: string[] = [];

const runnerDeps = (
	plugins: readonly Plugin[],
	enabled: ReadonlySet<string>,
	builtinStages: readonly MiddlewareStage[] = [],
): PageMiddlewareRunnerDeps => ({
	plugins,
	builtinStages,
	enabledIds: cachedEnabledIds(0),
	...makeRun(enabled),
});

const ctx = (plugins?: readonly Plugin[]): MiddlewareContext => ({
	path: "/x",
	context: "app",
	routeKey: "/x",
	...(plugins === undefined ? {} : { plugins }),
	state: {},
});

describe("makePageMiddlewareRunner", () => {
	it("skips disabled plugin stages and runs enabled ones", async () => {
		calls.length = 0;
		const plugins = [
			{ id: "mw.on", middleware: [stage("mw.on.stage")] },
			{ id: "mw.off", middleware: [stage("mw.off.stage")] },
			{ id: "pkg.a", pkg: "pkg.x", middleware: [stage("pkg.x.stage")] },
			{ id: "pkg.b", pkg: "pkg.x" },
			{ id: "pkg.dead", pkg: "pkg.y", middleware: [stage("pkg.y.stage")] },
		] as unknown as Plugin[];
		const run = makePageMiddlewareRunner(runnerDeps(plugins, new Set(["mw.on", "pkg.b"])));
		const verdict = await run(ctx(plugins));
		expect(verdict).toEqual({ type: "continue" });
		expect(calls).toEqual(["mw.on.stage", "pkg.x.stage"]);
	});

	it("returns the first non-continue verdict", async () => {
		const plugins = [
			{
				id: "mw.redir",
				middleware: [
					{
						id: "mw.redir.stage",
						order: 5,
						scope: { path: "/x" },
						handler: () => Effect.succeed(middlewareRedirect("/login")),
					},
				],
			},
		] as unknown as Plugin[];
		const run = makePageMiddlewareRunner(runnerDeps(plugins, new Set(["mw.redir"])));
		expect(await run(ctx(plugins))).toEqual({ type: "redirect", to: "/login" });
	});

	it("runs built-in stages and binds runAs once a user is stored", async () => {
		const seen: string[] = [];
		const principal: MiddlewareStage = {
			id: "test.principal",
			order: 10,
			handler: (c) =>
				Effect.sync(() => {
					c.state.user = { id: "u1" };
					return middlewareContinue();
				}),
		};
		const after: MiddlewareStage = {
			id: "test.after",
			order: 20,
			handler: () =>
				Effect.sync(() => {
					seen.push("after");
					return middlewareContinue();
				}),
		};
		const bound: string[] = [];
		const deps: PageMiddlewareRunnerDeps = {
			plugins: [],
			builtinStages: [principal, after],
			enabledIds: Effect.succeed(new Set<string>()),
			run: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
				Effect.runPromise(effect as Effect.Effect<A, E, never>),
			runAs: <A, E>(user: { id: string }, effect: Effect.Effect<A, E, unknown>) => {
				bound.push(user.id);
				return Effect.runPromise(effect as Effect.Effect<A, E, never>);
			},
		};
		const run = makePageMiddlewareRunner(deps);
		expect(await run(ctx())).toEqual({ type: "continue" });
		expect(seen).toEqual(["after"]);
		// The stage after the principal ran bound (user stored by order 10).
		expect(bound).toEqual(["u1"]);
	});

	it("runs with omitted builtinStages and memoizes the collected chain", async () => {
		calls.length = 0;
		const plugins = [
			{ id: "mw.memo", middleware: [stage("mw.memo.stage")] },
		] as unknown as Plugin[];
		const deps: PageMiddlewareRunnerDeps = {
			plugins,
			enabledIds: Effect.succeed(new Set(["mw.memo"])),
			...makeRun(new Set(["mw.memo"])),
		};
		const run = makePageMiddlewareRunner(deps);
		expect(await run(ctx(plugins))).toEqual({ type: "continue" });
		// Second dispatch reuses the memoized entries (and the `?? []`
		// builtinStages fallback ran on the first collect).
		expect(await run(ctx(plugins))).toEqual({ type: "continue" });
		expect(calls).toEqual(["mw.memo.stage", "mw.memo.stage"]);
	});

	it("maps a deny verdict through unchanged", async () => {
		const plugins = [
			{
				id: "mw.deny",
				middleware: [
					{
						id: "mw.deny.stage",
						handler: () => Effect.succeed(middlewareDeny("nope")),
					},
				],
			},
		] as unknown as Plugin[];
		const run = makePageMiddlewareRunner(runnerDeps(plugins, new Set(["mw.deny"])));
		expect(await run(ctx(plugins))).toEqual({ type: "deny", reason: "nope" });
	});
});

describe("cachedEnabledIds", () => {
	it("reads PluginStates.enabledIds through the effect", async () => {
		const ids = new Set(["a", "b"]);
		const result = await Effect.runPromise(
			cachedEnabledIds(0).pipe(Effect.provideService(PluginStates, states(ids) as never)),
		);
		expect(result).toBe(ids);
	});
});

describe("collectServerPages", () => {
	it("merges panel.pages and pages first-wins by path", () => {
		const plugins = [
			{ id: "p1", panel: { pages: [{ id: "a", path: "/x", component: () => null }] } },
			{
				id: "p2",
				panel: { pages: [{ id: "b", path: "/x", component: () => null }] },
				pages: [{ id: "c", path: "/y", component: () => null }],
			},
		] as unknown as Plugin[];
		const map = collectServerPages(plugins);
		expect(map.get("/x")?.id).toBe("a");
		expect(map.get("/y")?.id).toBe("c");
	});
});

// ---------- dispatchPage ----------

const pageEntry = (path: string, page: Record<string, unknown>, pluginId = "plug.a"): PageEntry =>
	({
		page: { id: "pg", path, component: () => null, ...page },
		pluginId,
	}) as unknown as PageEntry;

const dispatchDeps = (
	plugins: readonly Plugin[],
	maps: { appPages?: Map<string, PageEntry>; portalPages?: Map<string, PageEntry> },
	enabled: ReadonlySet<string> = new Set(),
): PageDispatchDeps => ({
	plugins,
	appPages: maps.appPages ?? new Map(),
	portalPages: maps.portalPages ?? new Map(),
	runMiddleware: async () => middlewareContinue(),
	...makeRun(enabled),
});

describe("dispatchPage", () => {
	it("returns notfound for an unregistered path", async () => {
		const deps = dispatchDeps([], {});
		expect(await dispatchPage({ path: "/nope", shell: "app" }, deps)).toEqual({
			status: "notfound",
		});
	});

	it("returns notfound when the entry context mismatches the shell", async () => {
		const appPages = new Map([["/p", pageEntry("/p", {})]]);
		const deps = dispatchDeps([], { appPages });
		expect(await dispatchPage({ path: "/p", shell: "portal" }, deps)).toEqual({
			status: "notfound",
		});
	});

	it("maps a middleware deny verdict to notfound", async () => {
		const appPages = new Map([["/p", pageEntry("/p", {})]]);
		const deps: PageDispatchDeps = {
			...dispatchDeps([], { appPages }),
			runMiddleware: async () => middlewareDeny("x"),
		};
		expect(await dispatchPage({ path: "/p", shell: "app" }, deps)).toEqual({
			status: "notfound",
		});
	});

	it("maps a middleware redirect verdict through", async () => {
		const appPages = new Map([["/p", pageEntry("/p", {})]]);
		const deps: PageDispatchDeps = {
			...dispatchDeps([], { appPages }),
			runMiddleware: async () => middlewareRedirect("/login"),
		};
		expect(await dispatchPage({ path: "/p", shell: "app" }, deps)).toEqual({
			status: "redirect",
			to: "/login",
		});
	});

	it("runs guard then loader, forwarding search", async () => {
		const seen: unknown[] = [];
		const appPages = new Map([
			[
				"/p",
				pageEntry("/p", {
					guard: (path: string) => Effect.sync(() => (seen.push(["guard", path]), true)),
					loader: (path: string, search?: Record<string, unknown>) =>
						Effect.sync(() => {
							seen.push(["loader", path, search]);
							return { ok: 1 };
						}),
				}),
			],
		]);
		const deps = dispatchDeps([], { appPages });
		const result = await dispatchPage({ path: "/p", shell: "app", search: { q: "1" } }, deps);
		expect(result).toEqual({ status: "ok", data: { ok: 1 } });
		expect(seen).toEqual([
			["guard", "/p"],
			["loader", "/p", { q: "1" }],
		]);
	});

	it("hides the page when the guard denies or fails", async () => {
		for (const guard of [() => Effect.succeed(false), () => Effect.fail("boom")]) {
			const appPages = new Map([["/p", pageEntry("/p", { guard })]]);
			const deps = dispatchDeps([], { appPages });
			expect(await dispatchPage({ path: "/p", shell: "app" }, deps)).toEqual({
				status: "notfound",
			});
		}
	});

	it("returns ok/null data for pages without a loader", async () => {
		const appPages = new Map([["/p", pageEntry("/p", {})]]);
		const deps = dispatchDeps([], { appPages });
		expect(await dispatchPage({ path: "/p", shell: "app" }, deps)).toEqual({
			status: "ok",
			data: null,
		});
	});

	it("resolves wildcard entries by longest base and looks handlers up by registered path", async () => {
		const appPages = new Map<string, PageEntry>([
			["/*", pageEntry("/*", { loader: () => Effect.succeed("wild") }, "wild.plugin")],
			["/docs/*", pageEntry("/docs/*", { loader: () => Effect.succeed("docs") }, "docs.plugin")],
		]);
		const plugins = [
			{ id: "docs.plugin", pages: [{ id: "d", path: "/docs/*", component: () => null }] },
		] as unknown as Plugin[];
		const deps = dispatchDeps(plugins, { appPages });
		expect(await dispatchPage({ path: "/docs/guide", shell: "app" }, deps)).toEqual({
			status: "ok",
			data: "docs",
		});
		expect(await dispatchPage({ path: "/other", shell: "app" }, deps)).toEqual({
			status: "ok",
			data: "wild",
		});
	});

	it("marks portal paths with subject doctor for doctor-subject instances", async () => {
		const seen: unknown[] = [];
		const portalPages = new Map([
			[
				"/portal/clin/visit",
				pageEntry("/portal/clin/visit", {
					loader: () => Effect.succeed("page"),
				}),
			],
		]);
		const plugins = [
			{
				id: "clin.plugin",
				portals: [
					{
						id: "clin",
						basePath: "/portal/clin",
						label: "Clin",
						subject: "doctor",
					},
				],
			},
		] as unknown as Plugin[];
		const deps: PageDispatchDeps = {
			...dispatchDeps(plugins, { portalPages }),
			runMiddleware: async (c) => {
				seen.push(c.subject);
				c.state.user = { id: "doc1" };
				return middlewareContinue();
			},
		};
		expect(await dispatchPage({ path: "/portal/clin/visit", shell: "portal" }, deps)).toEqual({
			status: "ok",
			data: "page",
		});
		expect(seen).toEqual(["doctor"]);
	});

	it("uses runAs for guard/loader once the principal stage stored a user", async () => {
		const bound: string[] = [];
		const appPages = new Map([["/p", pageEntry("/p", { loader: () => Effect.succeed("d") })]]);
		const base = dispatchDeps([], { appPages });
		const deps: PageDispatchDeps = {
			...base,
			runMiddleware: async (c) => {
				c.state.user = { id: "u9" };
				return middlewareContinue();
			},
			runAs: (user, effect) => {
				bound.push(user.id);
				return base.run(effect);
			},
		};
		expect(await dispatchPage({ path: "/p", shell: "app" }, deps)).toEqual({
			status: "ok",
			data: "d",
		});
		expect(bound).toEqual(["u9"]);
	});
});
