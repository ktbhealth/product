import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import {
	collectMiddlewareStages,
	middlewareContinue,
	type MiddlewareStage,
	type PackagedPlugin,
} from "@ktb/kernel";

import { PluginStates } from "./plugin-states.ts";
import { makeMiddlewareStages, MiddlewareStages } from "./middleware.ts";

const stage = (overrides: Partial<MiddlewareStage> = {}): MiddlewareStage => ({
	id: "test.stage",
	order: 10,
	handler: () => Effect.succeed(middlewareContinue()),
	...overrides,
});

const plugin = (id: string, pkg?: string, middleware: readonly MiddlewareStage[] = []): never =>
	({
		id,
		...(pkg === undefined ? {} : { pkg }),
		...(middleware.length === 0 ? {} : { middleware }),
	}) as never;

const states = (enabled: ReadonlySet<string>) =>
	({
		isEnabled: (id: string) => Effect.succeed(enabled.has(id)),
		enabledIds: () => Effect.succeed(enabled),
	}) as never;

const run = <A>(effect: Effect.Effect<A, unknown, PluginStates>, enabled: ReadonlySet<string>) =>
	Effect.runPromise(effect.pipe(Effect.provideService(PluginStates, states(enabled))));

describe("makeMiddlewareStages", () => {
	it("lists collected stages in effective order with live enablement", async () => {
		const plugins = [
			plugin("pkg.a", "pkg", [stage({ id: "pkg.stage", order: 50 })]),
			plugin("pkg.b", "pkg"),
			plugin("solo.c"),
		] as readonly PackagedPlugin[];
		const svc = makeMiddlewareStages({
			plugins,
			stages: collectMiddlewareStages(plugins, [stage({ id: "host.builtin", order: 5 })]),
			routes: [],
		});
		// Only pkg.b enabled → pkg.a's stage reports disabled (package
		// granularity: the package is live while ANY member id is on).
		const rows = await run(svc.stages(), new Set(["pkg.b"]));
		expect(rows.map((r) => r.id)).toEqual(["host.builtin", "pkg.stage"]);
		expect(rows[0]).toMatchObject({
			pluginId: "app-host",
			origin: "builtin",
			enabled: true,
		});
		expect(rows[1]).toMatchObject({
			pluginId: "pkg.a",
			pkg: "pkg",
			origin: "plugin",
			enabled: true,
		});
		// Sort internals never reach the row.
		expect(rows[0]).not.toHaveProperty("pluginIndex");
		expect(rows[0]).not.toHaveProperty("entryIndex");
	});

	it("reports plugin stages disabled when their package is fully off", async () => {
		const plugins = [
			plugin("pkg.a", "pkg", [stage({ id: "pkg.stage" })]),
		] as readonly PackagedPlugin[];
		const svc = makeMiddlewareStages({
			plugins,
			stages: collectMiddlewareStages(plugins),
			routes: [],
		});
		const rows = await run(svc.stages(), new Set());
		expect(rows[0]).toMatchObject({ id: "pkg.stage", enabled: false });
	});

	it("checks per-plugin enablement for entries without a pkg stamp", async () => {
		const plugins = [
			plugin("solo.a", undefined, [stage({ id: "solo.stage" })]),
		] as readonly PackagedPlugin[];
		const svc = makeMiddlewareStages({
			plugins,
			stages: collectMiddlewareStages(plugins),
			routes: [],
		});
		const on = await run(svc.stages(), new Set(["solo.a"]));
		expect(on[0]).toMatchObject({ enabled: true });
		const off = await run(svc.stages(), new Set());
		expect(off[0]).toMatchObject({ enabled: false });
	});

	it("returns the route projection unchanged", async () => {
		const routes = [{ path: "/platform", context: "platform", routeKey: "/platform" }];
		const svc = makeMiddlewareStages({ plugins: [], stages: [], routes });
		await expect(Effect.runPromise(svc.routes())).resolves.toBe(routes);
	});
});
