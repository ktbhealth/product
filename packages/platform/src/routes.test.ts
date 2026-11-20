import { describe, expect, expectTypeOf, it } from "vitest";
import type { Page, Plugin } from "@ktb/kernel";
import { definePlugin } from "@ktb/kernel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
	collectRouteDefinitions,
	makeRoutes,
	routeContribution,
	Routes,
	type PathParams,
	type RouteParams,
} from "./routes.ts";

// Local RouteRegistry augmentation — the same `declare module` contract
// plugins use; proves key typing + `:param` inference end to end.
declare module "@ktb/platform/routes" {
	interface RouteRegistry {
		"test.detail": "/test/:id";
		"test.pair": "/test/:tenant/:id";
		"test.static": "/test/static";
	}
}

const page = (id: string, path: string, extra?: Partial<Page>): Page => ({
	id,
	path,
	component: () => null,
	...extra,
});

describe("collectRouteDefinitions", () => {
	it("collects explicit route contributions", () => {
		const plugins: readonly Plugin[] = [
			definePlugin({
				id: "test.routes",
				contributions: [
					routeContribution("test.detail", { path: "/test/:id", params: ["id"] }),
					routeContribution("test.admin", {
						path: "/platform/test",
						portal: "platform",
						context: "portal",
					}),
				],
			}),
		];
		const defs = collectRouteDefinitions(plugins);
		expect(defs).toEqual([
			{
				key: "test.detail",
				path: "/test/:id",
				params: ["id"],
				pluginId: "test.routes",
			},
			{
				key: "test.admin",
				path: "/platform/test",
				portal: "platform",
				context: "portal",
				pluginId: "test.routes",
			},
		]);
	});

	it("derives defs from panel.pages and pages descriptors", () => {
		const plugins: readonly Plugin[] = [
			definePlugin({
				id: "test.panel",
				panel: { pages: [page("admin", "/platform/test")] },
			}),
			definePlugin({
				id: "test.pages",
				pages: [page("home", "/home"), page("custom", "/*", { routeKey: "test.custom" })],
			}),
		];
		const defs = collectRouteDefinitions(plugins);
		expect(defs.map((d) => d.key)).toEqual(["test.panel/admin", "test.pages/home", "test.custom"]);
		expect(defs[0]?.context).toBe("portal");
	});

	it("dies on duplicate route keys", () => {
		const plugins: readonly Plugin[] = [
			definePlugin({
				id: "a",
				contributions: [routeContribution("dup", { path: "/a" })],
			}),
			definePlugin({
				id: "b",
				contributions: [routeContribution("dup", { path: "/b" })],
			}),
		];
		expect(() => collectRouteDefinitions(plugins)).toThrow('duplicate route key "dup"');
	});

	it("dies on invalid contribution meta", () => {
		const plugins: readonly Plugin[] = [
			definePlugin({
				id: "bad",
				contributions: [{ kind: "route", id: "bad.meta", meta: { path: 42 } }],
			}),
		];
		expect(() => collectRouteDefinitions(plugins)).toThrow(/invalid "route" contribution/);
	});

	it("ignores contributions of other kinds", () => {
		const plugins: readonly Plugin[] = [
			definePlugin({
				id: "other",
				contributions: [{ kind: "eval.stage", id: "s1" }],
			}),
		];
		expect(collectRouteDefinitions(plugins)).toEqual([]);
	});

	it("dies on a route contribution with no meta", () => {
		const plugins: readonly Plugin[] = [
			definePlugin({
				id: "bad",
				contributions: [{ kind: "route", id: "bad.missing" }],
			}),
		];
		expect(() => collectRouteDefinitions(plugins)).toThrow(/invalid "route" contribution/);
	});
});

describe("makeRoutes", () => {
	const routes = makeRoutes([
		{ key: "home", path: "/", pluginId: "p" },
		{ key: "patients.list", path: "/patients", pluginId: "p" },
		{ key: "patients.detail", path: "/patients/:id", pluginId: "p" },
		{ key: "patients.edit", path: "/patients/:id/edit", pluginId: "p" },
		{ key: "docs", path: "/v/*", pluginId: "p" },
		{ key: "custom", path: "/*", pluginId: "p" },
	]);

	// Runtime defs aren't tied to the compile-time registry — call
	// through a loosely-typed alias for the runtime-behavior tests.
	const loose = routes.route as (key: string, params?: Record<string, unknown>) => string;

	it("route() resolves literal paths", () => {
		expect(loose("home")).toBe("/");
	});

	it("route() substitutes and encodes params", () => {
		expect(loose("patients.detail", { id: "42" })).toBe("/patients/42");
		expect(loose("patients.detail", { id: "a b/c" })).toBe("/patients/a%20b%2Fc");
	});

	it("route() throws on unknown key, wildcard and missing param", () => {
		expect(() => loose("nope")).toThrow('unknown route key "nope"');
		expect(() => loose("custom")).toThrow("wildcard");
		expect(() => loose("patients.detail")).toThrow('missing param "id"');
	});

	it("match() resolves exact paths", () => {
		expect(routes.match("/patients")).toEqual({ key: "patients.list", params: {} });
		expect(routes.match("/")).toEqual({ key: "home", params: {} });
	});

	it("match() normalizes paths without a leading slash", () => {
		expect(routes.match("patients/42")).toEqual({
			key: "patients.detail",
			params: { id: "42" },
		});
	});

	it("match() binds :param segments", () => {
		expect(routes.match("/patients/42")).toEqual({
			key: "patients.detail",
			params: { id: "42" },
		});
		expect(routes.match("/patients/42/edit")).toEqual({
			key: "patients.edit",
			params: { id: "42" },
		});
	});

	it("match() prefers exact over param over wildcard, longest wildcard base", () => {
		expect(routes.match("/v/anything/deep")).toEqual({ key: "docs", params: {} });
		expect(routes.match("/unknown/path")).toEqual({ key: "custom", params: {} });
		// "/v/x" matches both /v/* and /* — the longer base wins.
		expect(routes.match("/v/x")?.key).toBe("docs");
	});

	it("match() returns undefined when nothing matches", () => {
		const strict = makeRoutes([{ key: "a", path: "/a/:id", pluginId: "p" }]);
		expect(strict.match("/a")).toBeUndefined();
		expect(strict.match("/a/1/2")).toBeUndefined();
		expect(strict.match("/b")).toBeUndefined();
	});

	it("get()/list() expose the defs", () => {
		expect(routes.get("patients.detail")?.path).toBe("/patients/:id");
		expect(routes.list()).toHaveLength(6);
	});
});

describe("route key typing", () => {
	it("PathParams extracts :name segments from path literals", () => {
		expectTypeOf<PathParams<"/test/:id">>().toEqualTypeOf<"id">();
		expectTypeOf<PathParams<"/test/:tenant/:id">>().toEqualTypeOf<"tenant" | "id">();
		expectTypeOf<PathParams<"/test/static">>().toEqualTypeOf<never>();
		expectTypeOf<PathParams<"/test/:id/edit">>().toEqualTypeOf<"id">();
	});

	it("RouteParams is undefined for param-less paths, a record otherwise", () => {
		expectTypeOf<RouteParams<"test.static">>().toEqualTypeOf<undefined>();
		expectTypeOf<RouteParams<"test.detail">>().toEqualTypeOf<{
			id: string | number;
		}>();
		expectTypeOf<RouteParams<"test.pair">>().toEqualTypeOf<{
			tenant: string | number;
			id: string | number;
		}>();
	});

	it("route() accepts declared keys with matching params", () => {
		const typed = makeRoutes([
			{ key: "test.static", path: "/test/static", pluginId: "p" },
			{ key: "test.detail", path: "/test/:id", pluginId: "p" },
			{ key: "test.pair", path: "/test/:tenant/:id", pluginId: "p" },
		]);
		expect(typed.route("test.static")).toBe("/test/static");
		expect(typed.route("test.detail", { id: 7 })).toBe("/test/7");
		expect(typed.route("test.pair", { tenant: "t", id: "i" })).toBe("/test/t/i");
	});

	it("route() rejects undeclared keys and param mismatches at compile time", () => {
		const typed = makeRoutes([]);
		// Never invoked — these exist for the typechecker only.
		const typeChecks = () => {
			// @ts-expect-error — undeclared keys are rejected
			typed.route("nope");
			// @ts-expect-error — param'd routes require the params argument
			typed.route("test.detail");
			// @ts-expect-error — the params record is exact (no extra keys)
			typed.route("test.detail", { id: 1, extra: 2 });
			// @ts-expect-error — static routes take no params argument
			typed.route("test.static", { id: 1 });
		};
		expect(typeChecks).toBeTypeOf("function");
	});
});

describe("Routes service", () => {
	it("is providable as a layer", async () => {
		const layer = Layer.succeed(
			Routes,
			makeRoutes([{ key: "test.detail", path: "/k/:id", pluginId: "p" }]),
		);
		const program = Effect.gen(function* () {
			const routes = yield* Routes;
			return routes.route("test.detail", { id: "9" });
		});
		await expect(Effect.runPromise(program.pipe(Effect.provide(layer)))).resolves.toBe("/k/9");
	});
});
