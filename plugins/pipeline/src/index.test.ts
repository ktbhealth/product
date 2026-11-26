import { describe, expect, it } from "vitest";

import { definePlugin, type Plugin } from "@ktb/kernel";
import type { OrchestrationKind, OrchestrationPack } from "@ktb/orchestrator";
import type { PipelinePack, PipelineStage } from "@ktb/pipeline";
import * as Effect from "effect/Effect";

import {
	collectOrchestratorPacks,
	collectPipelinePacks,
	orchestratorRegistryLive,
	pipelineRegistryLive,
	plugins,
} from "./index.ts";

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

const kind = (id: string): OrchestrationKind => ({
	id,
	run: () => Effect.succeed({}),
});

const orchestrationPack = (id: string, kindId = "k"): OrchestrationPack => ({
	def: {
		id,
		nodes: [{ id: "n", kind: kindId, on: ["input"], emits: [] }],
	},
	kinds: [kind(kindId)],
});

const pluginWithOrchestrations = (
	id: string,
	orchestrations?: readonly OrchestrationPack[],
): Plugin => definePlugin({ id, ...(orchestrations === undefined ? {} : { orchestrations }) });

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

describe("collectOrchestratorPacks", () => {
	it("returns an empty list for no plugins", () => {
		expect(collectOrchestratorPacks([])).toEqual([]);
	});

	it("skips plugins that contribute no orchestrations field", () => {
		const plugins = [
			pluginWithOrchestrations("a.only"),
			pluginWithOrchestrations("b.packs", [orchestrationPack("o1")]),
		];
		expect(collectOrchestratorPacks(plugins).map((p) => p.def.id)).toEqual(["o1"]);
	});

	it("flattens packs across plugins in plugin order", () => {
		const plugins = [
			pluginWithOrchestrations("a.packs", [orchestrationPack("o1"), orchestrationPack("o2")]),
			pluginWithOrchestrations("b.none"),
			pluginWithOrchestrations("c.packs", [orchestrationPack("o3")]),
		];
		expect(collectOrchestratorPacks(plugins).map((p) => p.def.id)).toEqual(["o1", "o2", "o3"]);
	});
});

describe("orchestratorRegistryLive", () => {
	it("builds a layer that registers collected kinds and defs", async () => {
		const { OrchestratorRegistry } = await import("@ktb/orchestrator");
		const layer = orchestratorRegistryLive([
			pluginWithOrchestrations("a.packs", [orchestrationPack("demo")]),
		]);
		const registry = await Effect.runPromise(
			Effect.flatMap(OrchestratorRegistry, (r) =>
				Effect.sync(() => ({
					has: r.has("demo"),
					ids: r.listDefs().map((d) => d.id),
					kinds: r.listKinds().map((k) => k.id),
				})),
			).pipe(Effect.provide(layer)),
		);
		expect(registry).toEqual({ has: true, ids: ["demo"], kinds: ["k"] });
	});

	it("seeds extraKinds ahead of pack kinds", async () => {
		const { OrchestratorRegistry } = await import("@ktb/orchestrator");
		const layer = orchestratorRegistryLive(
			[pluginWithOrchestrations("a.packs", [orchestrationPack("demo")])],
			[kind("builtin.x")],
		);
		const kinds = await Effect.runPromise(
			Effect.flatMap(OrchestratorRegistry, (r) =>
				Effect.sync(() => r.listKinds().map((k) => k.id)),
			).pipe(Effect.provide(layer)),
		);
		expect(kinds).toEqual(["builtin.x", "k"]);
	});

	it("fails layer build when a def references an unregistered kind", async () => {
		const { OrchestratorRegistry } = await import("@ktb/orchestrator");
		const orphan: OrchestrationPack = {
			def: { id: "orphan", nodes: [{ id: "n", kind: "missing", on: ["input"], emits: [] }] },
			kinds: [],
		};
		const layer = orchestratorRegistryLive([pluginWithOrchestrations("a.packs", [orphan])]);
		const exit = await Effect.runPromiseExit(
			Effect.flatMap(OrchestratorRegistry, (r) => Effect.sync(() => r.has("orphan"))).pipe(
				Effect.provide(layer),
			),
		);
		expect(exit._tag).toBe("Failure");
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
