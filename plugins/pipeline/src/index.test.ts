import { describe, expect, it } from "vitest";

import { definePlugin, type Plugin } from "@ktb/kernel";
import type { OrchestrationKind, OrchestrationPack } from "@ktb/orchestrator";
import type { Db } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";
import type { PlatformAdmin } from "@ktb/platform";
import type { PipelinePack, PipelineStage } from "@ktb/pipeline";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

describe("pipeline.admin.panel loaders", () => {
	const panel = plugins.find((p) => p.id === "pipeline.admin.panel");
	const listLoader = panel?.panel?.pages?.[0]?.loader as () => Effect.Effect<
		{ rows: readonly unknown[] },
		unknown,
		PlatformAdmin | Db
	>;
	const editorLoader = panel?.panel?.pages?.[1]?.loader as (
		path: string,
	) => Effect.Effect<
		{ mode: string; def: unknown; kinds: readonly string[] },
		unknown,
		PlatformAdmin | Db
	>;

	const envFor = async (opts: { admin?: boolean; registry?: boolean } = {}) => {
		const [{ Db, makeDb }, { makeD1 }, platform, authz, orchestrator] = await Promise.all([
			import("@ktb/db"),
			import("@ktb/db/testing"),
			import("@ktb/platform"),
			import("@ktb/authz"),
			import("@ktb/orchestrator"),
		]);
		const db = makeDb(makeTestD1());
		const admin = opts.admin !== false;
		const gate = platform.makePlatformAdminGate(
			platform.parsePlatformAdminEmails(admin ? "admin@x.com" : ""),
		);
		const base = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(platform.PlatformAdmin, gate),
			Layer.succeed(authz.Principal, {
				userId: "u1",
				email: admin ? "admin@x.com" : "user@x.com",
			}),
		);
		const layer = opts.registry
			? Layer.mergeAll(
					base,
					Layer.succeed(
						orchestrator.OrchestratorRegistry,
						orchestrator.makeOrchestratorRegistry([
							{ id: "stage.custom", run: () => Effect.succeed({}) },
						]),
					),
				)
			: base;
		return { db, layer };
	};

	it("list loader returns rows for admins and collapses Forbidden to empty", async () => {
		const { db, layer } = await envFor();
		const { upsertOrchestrationDef } = await import("@ktb/orchestrator");
		await upsertOrchestrationDef(db, {
			id: "demo",
			nodes: [{ id: "n", kind: "emit", on: ["start"], emits: [] }],
		});
		const result = await Effect.runPromise(listLoader().pipe(Effect.provide(layer)));
		expect(result.rows).toEqual([
			expect.objectContaining({ id: "demo", nodeCount: 1, enabled: true }),
		]);

		const denied = await envFor({ admin: false });
		const empty = await Effect.runPromise(listLoader().pipe(Effect.provide(denied.layer)));
		expect(empty).toEqual({ rows: [] });
	});

	it("editor loader resolves new/missing/existing defs and kind palettes", async () => {
		const { db, layer } = await envFor();
		const { upsertOrchestrationDef } = await import("@ktb/orchestrator");
		await upsertOrchestrationDef(db, {
			id: "demo",
			nodes: [{ id: "n", kind: "emit", on: ["start"], emits: [] }],
		});

		// "new" suffix and non-prefixed paths both open a blank def.
		for (const path of ["/platform/pipelines/new", "/platform/pipelines/", "/other"]) {
			const data = await Effect.runPromise(editorLoader(path).pipe(Effect.provide(layer)));
			expect(data).toMatchObject({ mode: "new", def: null });
			expect(data.kinds).toContain("emit");
		}

		const missing = await Effect.runPromise(
			editorLoader("/platform/pipelines/nope").pipe(Effect.provide(layer)),
		);
		expect(missing).toMatchObject({ mode: "edit", def: null });

		const existing = await Effect.runPromise(
			editorLoader("/platform/pipelines/demo").pipe(Effect.provide(layer)),
		);
		expect(existing.mode).toBe("edit");
		expect((existing.def as { def?: { id?: string } } | null)?.def?.id).toBe("demo");

		// Malformed percent-encoding degrades to the raw suffix → no row.
		const mangled = await Effect.runPromise(
			editorLoader("/platform/pipelines/%E0%A4%A").pipe(Effect.provide(layer)),
		);
		expect(mangled).toMatchObject({ mode: "edit", def: null });
	});

	it("editor loader prefers the live registry kinds and collapses Forbidden", async () => {
		const { layer } = await envFor({ registry: true });
		const data = await Effect.runPromise(
			editorLoader("/platform/pipelines/new").pipe(Effect.provide(layer)),
		);
		expect(data.kinds).toEqual(["stage.custom"]);

		const denied = await envFor({ admin: false });
		const empty = await Effect.runPromise(
			editorLoader("/platform/pipelines/x").pipe(Effect.provide(denied.layer)),
		);
		expect(empty).toEqual({ mode: "edit", def: null, kinds: [] });
	});
});
