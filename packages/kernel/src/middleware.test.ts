import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import type { Plugin } from "./contributions.ts";
import { definePlugin } from "./index.ts";
import {
	collectMiddlewareStages,
	effectiveMiddlewareChain,
	middlewareContinue,
	middlewareDeny,
	middlewarePathMatches,
	middlewareRedirect,
	middlewareScopeMatches,
	middlewareStageInfo,
	orderMiddlewareEntries,
	type MiddlewareStage,
	type MiddlewareStageEntry,
} from "./middleware.ts";

const stage = (id: string, extra: Partial<MiddlewareStage> = {}): MiddlewareStage => ({
	id,
	handler: () => Effect.succeed(middlewareContinue()),
	...extra,
});

const entry = (
	s: MiddlewareStage,
	pluginIndex: number,
	entryIndex: number,
	origin: "plugin" | "builtin" = "plugin",
): MiddlewareStageEntry => ({
	...s,
	pluginId: `p${pluginIndex}`,
	origin,
	pluginIndex,
	entryIndex,
});

describe("middlewarePathMatches", () => {
	it("matches exact paths, wildcard subtree and bare star", () => {
		expect(middlewarePathMatches("/a", "/a")).toBe(true);
		expect(middlewarePathMatches("/a", "/ab")).toBe(false);
		expect(middlewarePathMatches("/a/*", "/a")).toBe(true);
		expect(middlewarePathMatches("/a/*", "/a/b/c")).toBe(true);
		expect(middlewarePathMatches("/a/*", "/ab")).toBe(false);
		expect(middlewarePathMatches("/*", "/anything")).toBe(true);
		expect(middlewarePathMatches("*", "/anything")).toBe(true);
	});
});

describe("middlewareScopeMatches", () => {
	const req = { path: "/platform/x", context: "portal", routeKey: "/platform/x" };

	it("undefined scope matches everything", () => {
		expect(middlewareScopeMatches(undefined, req)).toBe(true);
		expect(middlewareScopeMatches({}, req)).toBe(true);
	});

	it("requires every declared field to match", () => {
		expect(middlewareScopeMatches({ context: "portal" }, req)).toBe(true);
		expect(middlewareScopeMatches({ context: "app" }, req)).toBe(false);
		expect(middlewareScopeMatches({ routeKey: "/platform/x" }, req)).toBe(true);
		expect(middlewareScopeMatches({ routeKey: "/platform/y" }, req)).toBe(false);
		expect(middlewareScopeMatches({ path: "/platform/*" }, req)).toBe(true);
		expect(middlewareScopeMatches({ path: "/app/*" }, req)).toBe(false);
		expect(middlewareScopeMatches({ context: "portal", path: "/platform/*" }, req)).toBe(true);
		expect(middlewareScopeMatches({ context: "app", path: "/platform/*" }, req)).toBe(false);
	});

	it("routeKey scope does not match requests without one", () => {
		expect(middlewareScopeMatches({ routeKey: "/platform/x" }, { path: "/platform/x" })).toBe(
			false,
		);
	});
});

describe("orderMiddlewareEntries", () => {
	it("sorts by order, defaulting absent order to MIDDLEWARE_ORDER_DEFAULT", () => {
		const sorted = orderMiddlewareEntries([
			entry(stage("late"), 0, 0),
			entry(stage("early", { order: 10 }), 0, 0),
			entry(stage("mid", { order: 50 }), 0, 0),
		]);
		expect(sorted.map((e) => e.id)).toEqual(["early", "mid", "late"]);
	});

	it("breaks order ties by pluginIndex then entryIndex; builtins (pluginIndex -1) first", () => {
		const sorted = orderMiddlewareEntries([
			entry(stage("plugin-b"), 1, 0),
			entry(stage("builtin"), -1, 0, "builtin"),
			entry(stage("plugin-a1"), 0, 1),
			entry(stage("plugin-a0"), 0, 0),
		]);
		expect(sorted.map((e) => e.id)).toEqual(["builtin", "plugin-a0", "plugin-a1", "plugin-b"]);
	});
});

describe("effectiveMiddlewareChain", () => {
	it("orders then filters by scope", () => {
		const chain = effectiveMiddlewareChain(
			[
				entry(stage("all"), 0, 0),
				entry(stage("portal-only", { scope: { context: "portal" } }), 0, 1),
				entry(stage("app-only", { scope: { context: "app" }, order: 1 }), 0, 2),
			],
			{ path: "/p", context: "portal" },
		);
		expect(chain.map((e) => e.id)).toEqual(
			["all", "portal-only", "app-only"].filter((id) => id !== "app-only"),
		);
	});
});

describe("verdict helpers", () => {
	it("builds verdicts", () => {
		expect(middlewareContinue()).toEqual({ type: "continue" });
		expect(middlewareDeny()).toEqual({ type: "deny" });
		expect(middlewareDeny("no")).toEqual({ type: "deny", reason: "no" });
		expect(middlewareRedirect("/login")).toEqual({ type: "redirect", to: "/login" });
		expect(middlewareRedirect("/login", true)).toEqual({
			type: "redirect",
			to: "/login",
			replace: true,
		});
	});
});

describe("middlewareStageInfo", () => {
	it("strips the handler and keeps display fields", () => {
		const e = entry(stage("s", { order: 5, scope: { path: "/x/*" } }), 2, 1);
		(e as { pkg?: string }).pkg = "plugins/x";
		expect(middlewareStageInfo(e)).toEqual({
			id: "s",
			order: 5,
			scope: { path: "/x/*" },
			pluginId: "p2",
			pkg: "plugins/x",
			origin: "plugin",
			pluginIndex: 2,
			entryIndex: 1,
		});
	});

	it("omits absent optional fields", () => {
		const e = entry(stage("bare"), 0, 0);
		expect(middlewareStageInfo(e)).toEqual({
			id: "bare",
			pluginId: "p0",
			origin: "plugin",
			pluginIndex: 0,
			entryIndex: 0,
		});
	});
});

describe("collectMiddlewareStages", () => {
	it("collects plugin stages with provenance and appends builtins first", () => {
		const registry: readonly Plugin[] = [
			definePlugin({
				id: "a.middleware",
				pkg: "plugins/a",
				middleware: [stage("a.one"), stage("a.two", { order: 1 })],
			}),
			definePlugin({ id: "b.marker" }),
			definePlugin({
				id: "c.middleware",
				middleware: [stage("c.one")],
			}),
		];
		const entries = collectMiddlewareStages(registry, [stage("builtin")]);
		expect(entries.map((e) => e.id)).toEqual(["builtin", "a.one", "a.two", "c.one"]);
		const aOne = entries[1]!;
		expect(aOne.pluginId).toBe("a.middleware");
		expect(aOne.pkg).toBe("plugins/a");
		expect(aOne.origin).toBe("plugin");
		expect(aOne.pluginIndex).toBe(0);
		expect(aOne.entryIndex).toBe(0);
		const cOne = entries[3]!;
		expect(cOne.pluginIndex).toBe(2);
		expect(entries[0]).toMatchObject({
			pluginId: "app-host",
			origin: "builtin",
			pluginIndex: -1,
		});
	});

	it("skips malformed stages with a dev warning", () => {
		const registry = [
			{
				id: "bad.middleware",
				middleware: [{ id: "no-handler" }, stage("good")],
			},
		] as unknown as readonly Plugin[];
		const entries = collectMiddlewareStages(registry);
		expect(entries.map((e) => e.id)).toEqual(["good"]);
	});

	it("handles plugins without middleware and empty registry", () => {
		expect(collectMiddlewareStages([])).toEqual([]);
		expect(collectMiddlewareStages([definePlugin({ id: "x.marker" })]).length).toBe(0);
	});
});
