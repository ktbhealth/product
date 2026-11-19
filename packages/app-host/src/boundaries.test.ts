import { describe, expect, it } from "vitest";
import type { BoundaryContribution, Plugin } from "@ktb/kernel";

import { collectBoundaries, selectErrorBoundary, selectNotFoundBoundary } from "./boundaries.ts";

const NotFound = () => null;
const ErrorBoundary = () => null;

const boundaryPlugin = (
	id: string,
	boundaries: readonly BoundaryContribution[],
	opts: { pkg?: string; priority?: Plugin["priority"] } = {},
): Plugin => ({ id, ...opts, boundaries });

const notFound = { kind: "notFound", component: NotFound } as const;
const error = { kind: "error", component: ErrorBoundary } as const;

describe("collectBoundaries", () => {
	it("flattens boundary contributions in plugin topo order with owner stamps", () => {
		const entries = collectBoundaries([
			boundaryPlugin("a.boundaries", [notFound], { pkg: "a", priority: "low" }),
			{ id: "b.marker" },
			boundaryPlugin("b.boundaries", [notFound, error], { pkg: "b", priority: "high" }),
			boundaryPlugin("c.boundaries", [error]),
		]);
		expect(entries.map((e) => [e.pluginId, e.pkg, e.priority, e.kind])).toEqual([
			["a.boundaries", "a", "low", "notFound"],
			["b.boundaries", "b", "high", "notFound"],
			["b.boundaries", "b", "high", "error"],
			["c.boundaries", undefined, undefined, "error"],
		]);
	});
});

describe("boundary selection", () => {
	const plugins = [
		boundaryPlugin("low.boundaries", [notFound, error], { pkg: "low", priority: "low" }),
		boundaryPlugin("mid.boundaries", [notFound], { pkg: "mid" }),
		boundaryPlugin("high.boundaries", [error], { pkg: "high", priority: "high" }),
	];
	const entries = collectBoundaries(plugins);
	const enabled = (...ids: string[]) => new Set(ids);

	it("picks the highest priority live entry per kind", () => {
		expect(selectNotFoundBoundary(entries, plugins, enabled("low.boundaries"))?.pluginId).toBe(
			"low.boundaries",
		);
		expect(
			selectNotFoundBoundary(entries, plugins, enabled("low.boundaries", "mid.boundaries"))
				?.pluginId,
		).toBe("mid.boundaries");
		expect(
			selectErrorBoundary(entries, plugins, enabled("low.boundaries", "high.boundaries"))?.pluginId,
		).toBe("high.boundaries");
	});

	it("breaks equal priority ties by plugin topo order", () => {
		const tied = [
			boundaryPlugin("first.boundaries", [notFound], { pkg: "first" }),
			boundaryPlugin("second.boundaries", [notFound], { pkg: "second", priority: "medium" }),
		];
		const tiedEntries = collectBoundaries(tied);
		expect(
			selectNotFoundBoundary(tiedEntries, tied, enabled("first.boundaries", "second.boundaries"))
				?.pluginId,
		).toBe("first.boundaries");
	});

	it("applies the package-granular enabled gate", () => {
		const pkgPlugins = [
			{ id: "pkg.one", pkg: "pkg" },
			boundaryPlugin("pkg.two", [notFound], { pkg: "pkg", priority: "high" }),
		];
		const pkgEntries = collectBoundaries(pkgPlugins);
		expect(selectNotFoundBoundary(pkgEntries, pkgPlugins, enabled("pkg.one"))?.pluginId).toBe(
			"pkg.two",
		);
		expect(selectNotFoundBoundary(pkgEntries, pkgPlugins, enabled())).toBeUndefined();
	});

	it("returns undefined when no live entry exists", () => {
		expect(selectNotFoundBoundary(entries, plugins, enabled())).toBeUndefined();
		expect(selectErrorBoundary(entries, plugins, enabled("mid.boundaries"))).toBeUndefined();
	});
});
