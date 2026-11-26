import { describe, expect, it } from "vitest";

import { definePlugin, type Plugin } from "@ktb/kernel";
import type { PipelinePack, PipelineStage } from "@ktb/pipeline";
import * as Effect from "effect/Effect";

import { collectPipelinePacks, pipelineRegistryLive, plugins } from "./index.ts";

const stage = (id: string): PipelineStage => ({
	id,
	run: () => Effect.succeed({}),
});

const pack = (id: string): PipelinePack => ({
	def: { id, stages: [{ id: "s" }] },
	stages: { s: stage("s") },
});

const pluginWith = (id: string, pipelines?: readonly PipelinePack[]): Plugin =>
	definePlugin({ id, ...(pipelines === undefined ? {} : { pipelines }) });

describe("collectPipelinePacks", () => {
	it("returns an empty list for no plugins", () => {
		expect(collectPipelinePacks([])).toEqual([]);
	});

	it("skips plugins that contribute no pipelines field", () => {
		const plugins = [pluginWith("a.only"), pluginWith("b.packs", [pack("p1")])];
		expect(collectPipelinePacks(plugins).map((p) => p.def.id)).toEqual(["p1"]);
	});

	it("flattens packs across plugins in plugin order", () => {
		const plugins = [
			pluginWith("a.packs", [pack("p1"), pack("p2")]),
			pluginWith("b.none"),
			pluginWith("c.packs", [pack("p3")]),
		];
		expect(collectPipelinePacks(plugins).map((p) => p.def.id)).toEqual(["p1", "p2", "p3"]);
	});
});

describe("pipelineRegistryLive", () => {
	it("builds a layer that registers the collected packs", async () => {
		const { PipelineRegistry } = await import("@ktb/pipeline");
		const layer = pipelineRegistryLive([pluginWith("a.packs", [pack("demo")])]);
		const registry = await Effect.runPromise(
			Effect.flatMap(PipelineRegistry, (r) =>
				Effect.sync(() => ({ has: r.has("demo"), ids: r.list().map((d) => d.id) })),
			).pipe(Effect.provide(layer)),
		);
		expect(registry).toEqual({ has: true, ids: ["demo"] });
	});
});

describe("pipeline manifests", () => {
	it("exposes the composition plugin plus the admin chrome/panel plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"pipeline.core",
			"pipeline.admin.chrome",
			"pipeline.admin.panel",
		]);
		const p = plugins[0];
		expect(p?.meta?.keywords?.[0]).toBe("platform");
		expect(p?.tables).toBeUndefined();
		expect(p?.services).toBeUndefined();
		expect(p?.pipelines).toBeUndefined();
	});

	it("admin plugins order after the platform panel and contribute the expected surface", () => {
		const chrome = plugins.find((p) => p.id === "pipeline.admin.chrome");
		const panel = plugins.find((p) => p.id === "pipeline.admin.panel");
		expect(chrome?.requiredDeps).toEqual(["platform.panel"]);
		expect(panel?.requiredDeps).toEqual(["platform.panel"]);
		expect(chrome?.chrome?.[0]?.content).toMatchObject({
			kind: "sidebarItem",
			item: { to: "/platform/pipelines", group: "Runtime" },
		});
		const paths = (panel?.panel?.pages ?? []).map((page) => page.path);
		expect(paths).toEqual(["/platform/pipelines", "/platform/pipelines/*"]);
	});
});
