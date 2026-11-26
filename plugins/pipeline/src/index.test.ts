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

describe("pipeline.core manifest", () => {
	it("exposes a single data-only plugin", () => {
		expect(plugins.map((p) => p.id)).toEqual(["pipeline.core"]);
		const p = plugins[0];
		expect(p?.meta?.keywords?.[0]).toBe("platform");
		expect(p?.tables).toBeUndefined();
		expect(p?.services).toBeUndefined();
		expect(p?.pipelines).toBeUndefined();
	});
});
