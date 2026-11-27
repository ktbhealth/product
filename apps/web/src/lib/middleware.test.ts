import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MiddlewareContext } from "@ktb/kernel";

// runPageMiddleware gates plugin-contributed `middleware` stages on the
// live PluginStates enabled set — package-granular via entryEnabled,
// same predicate the MiddlewareStages admin view reports — while
// built-ins always run. platform.ts is mocked: run/runAs execute the
// Effect with a controllable PluginStates and a fixed fixture
// registry, so enabled flips are observable through state.enabled
// (mutated in place: cachedEnabledIds caches the Set by reference).

const state = vi.hoisted(() => ({
	enabled: new Set<string>(),
	calls: [] as string[],
}));

vi.mock("#/lib/auth.ts", () => ({
	getSessionUser: async () => null,
	getDoctorUser: async () => null,
}));

vi.mock("#/lib/platform.ts", async () => {
	const Effect = await import("effect/Effect");
	const kernel = await import("@ktb/kernel");
	const { PluginStates } = await import("@ktb/platform/plugin-states");
	const states = {
		isEnabled: (id: string) => Effect.succeed(state.enabled.has(id)),
		enabledIds: () => Effect.succeed(state.enabled),
	};
	const runEffect = (effect: any) =>
		Effect.runPromise(effect.pipe(Effect.provideService(PluginStates, states as never)));
	const stage = (id: string) => ({
		id,
		order: 50,
		handler: () =>
			Effect.sync(() => {
				state.calls.push(id);
				return kernel.middlewareContinue();
			}),
	});
	return {
		run: (effect: any) => runEffect(effect),
		runAs: (_user: unknown, effect: any) => runEffect(effect),
		serverPlugins: [
			// Per-id enablement (no pkg stamp).
			{ id: "mw.on", middleware: [stage("mw.on.stage")] },
			{ id: "mw.off", middleware: [stage("mw.off.stage")] },
			// Package granularity: pkg.x stays live while ANY member id
			// is enabled — pkg.a is off but pkg.b keeps pkg.x live.
			{ id: "pkg.a", pkg: "pkg.x", middleware: [stage("pkg.x.stage")] },
			{ id: "pkg.b", pkg: "pkg.x" },
			// Fully disabled package.
			{ id: "pkg.dead", pkg: "pkg.y", middleware: [stage("pkg.y.stage")] },
		] as never,
	};
});

import { runPageMiddleware } from "./middleware.ts";
import { serverPlugins } from "./platform.ts";

const ctx = (): MiddlewareContext => ({
	path: "/x",
	context: "app",
	routeKey: "/x",
	// The dispatch edge always supplies the registry (fns.ts passes
	// serverPlugins); pkg-scoped checks fail closed without it.
	plugins: serverPlugins,
	state: {},
});

const setEnabled = (...ids: string[]) => {
	state.enabled.clear();
	for (const id of ids) state.enabled.add(id);
};

describe("runPageMiddleware enablement gate", () => {
	beforeEach(() => {
		state.calls = [];
	});

	it("skips disabled plugin stages and runs enabled ones", async () => {
		setEnabled("mw.on", "pkg.b");
		const verdict = await runPageMiddleware(ctx());
		expect(verdict).toEqual({ type: "continue" });
		// mw.off (per-id off) and pkg.y (package fully off) never ran;
		// pkg.x ran on pkg.b's membership even though pkg.a is off.
		expect(state.calls).toEqual(["mw.on.stage", "pkg.x.stage"]);
	});

	it("runs a stage once its plugin is re-enabled", async () => {
		setEnabled("mw.off", "pkg.dead");
		const verdict = await runPageMiddleware(ctx());
		expect(verdict).toEqual({ type: "continue" });
		expect(state.calls).toEqual(["mw.off.stage", "pkg.y.stage"]);
	});
});
