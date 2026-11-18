import { describe, expect, it } from "vitest";
import type { ChromeContribution, Plugin } from "@ktb/kernel";

import { loginTileTargets, visibleLoginTiles } from "./login-tiles.ts";

const Icon = () => null;

const tile = (id: string, to: string, requires?: readonly string[]): ChromeContribution => ({
	id,
	region: "app.login.tiles",
	content: { kind: "loginTile", to, labelKey: `key_${id}`, fallback: id, icon: Icon, requires },
});

const plugin = (id: string, chrome: ChromeContribution[] = [], pkg?: string): Plugin =>
	({ id, pkg, chrome }) as Plugin;

const states = (...enabled: string[]) => ({ enabled });

describe("visibleLoginTiles", () => {
	it("collects loginTile entries in order and drops other kinds", () => {
		const plugins = [
			plugin("a.chrome", [
				tile("a.late", "/login/b", undefined),
				{
					id: "a.link",
					region: "app.login.tiles",
					content: { kind: "link", to: "/x", label: "x" },
				},
			]),
			plugin("b.chrome", [tile("b.early", "/login/a")]),
		];
		// order fields absent → plugin topo order then array index.
		const tiles = visibleLoginTiles(plugins, states("a.chrome", "b.chrome"));
		expect(tiles.map((e) => e.id)).toEqual(["a.late", "b.early"]);
	});

	it("hides tiles whose plugin is disabled", () => {
		const plugins = [plugin("a.chrome", [tile("a.tile", "/login/a")])];
		expect(visibleLoginTiles(plugins, states())).toEqual([]);
	});

	it("gates requires package-granularly: any member id keeps the pkg live", () => {
		const plugins = [
			plugin("dep.one", [], "dep-pkg"),
			plugin("dep.two", [], "dep-pkg"),
			plugin("a.chrome", [tile("a.tile", "/login/a", ["dep.one"])]),
		];
		// dep.one itself is disabled, but dep.two (same package) is on.
		expect(visibleLoginTiles(plugins, states("a.chrome", "dep.two")).map((e) => e.id)).toEqual([
			"a.tile",
		]);
		expect(visibleLoginTiles(plugins, states("a.chrome"))).toEqual([]);
	});

	it("gates unstamped requires ids per-id", () => {
		const plugins = [
			plugin("platform.anchor"),
			plugin("a.chrome", [tile("a.tile", "/login/a", ["platform.anchor"])]),
		];
		expect(visibleLoginTiles(plugins, states("a.chrome", "platform.anchor"))).toHaveLength(1);
		expect(visibleLoginTiles(plugins, states("a.chrome"))).toEqual([]);
	});

	it("fails closed on unknown requires ids", () => {
		const plugins = [plugin("a.chrome", [tile("a.tile", "/login/a", ["nope.missing"])])];
		expect(visibleLoginTiles(plugins, states("a.chrome"))).toEqual([]);
	});
});

describe("loginTileTargets", () => {
	it("returns the to paths of the visible tiles", () => {
		const plugins = [
			plugin("a.chrome", [tile("a.tile", "/login/a")]),
			plugin("b.chrome", [tile("b.tile", "/login/b", ["missing.id"])]),
		];
		expect(loginTileTargets(plugins, states("a.chrome", "b.chrome"))).toEqual(
			new Set(["/login/a"]),
		);
	});
});
