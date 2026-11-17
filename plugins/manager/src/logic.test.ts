import { describe, expect, it } from "vitest";

import { definePlugin, type Plugin, type PluginConfigSchema, type PluginId } from "@ktb/kernel";
import * as Layer from "effect/Layer";

import {
	configFormFields,
	contributionKinds,
	dependentClosure,
	disabledClosure,
	focusNeighborhood,
	graphFromPlugins,
	kindConsumers,
	layeredLayout,
	missingRequiredDeps,
	pluginDisplayName,
	regionEdgeTarget,
	requiredClosure,
	type GraphEdge,
} from "./logic.ts";

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"t.a": true;
		"t.b": true;
		"t.c": true;
		"t.d": true;
		"t.chrome": true;
		"t.panel": true;
		"t.tables": true;
		"t.services": true;
		"t.routes": true;
		"t.landing": true;
		"t.top": true;
		"t.opt": true;
		"t.pub": true;
		"t.contrib": true;
		"t.x": true;
		"t.y": true;
		"t.reorder.c": true;
		"dashboard.panel": true;
		"manager.panel": true;
	}
}

const dep = (id: string, deps: readonly string[] = []) =>
	definePlugin({ id, requiredDeps: deps as unknown as readonly PluginId[] });

// a ← b ← c chain; d independent.
const plugins: readonly Plugin[] = [
	dep("t.a"),
	dep("t.b", ["t.a"]),
	dep("t.c", ["t.b"]),
	dep("t.d"),
];

describe("pluginDisplayName", () => {
	it("prefers meta.name, falls back to id", () => {
		expect(pluginDisplayName({ id: "x", meta: { name: "X" } })).toBe("X");
		expect(pluginDisplayName({ id: "x.y" })).toBe("x.y");
		expect(pluginDisplayName({ id: "x", meta: {} })).toBe("x");
	});
});

describe("contributionKinds", () => {
	it("lists the contribution fields a plugin carries", () => {
		expect(contributionKinds(dep("t.a"))).toEqual([]);
		expect(
			contributionKinds(
				definePlugin({
					id: "t.chrome",
					chrome: [
						{
							id: "c",
							region: "portal.sidebar",
							content: { kind: "link", to: "/x", label: "X" },
						},
					],
				}),
			),
		).toEqual(["chrome"]);
		expect(contributionKinds(definePlugin({ id: "t.tables", tables: {} }))).toEqual(["tables"]);
		expect(contributionKinds(definePlugin({ id: "t.panel", panel: {} }))).toEqual(["panel"]);
		expect(contributionKinds(definePlugin({ id: "t.routes", routes: [] }))).toEqual(["routes"]);
		expect(contributionKinds(definePlugin({ id: "t.services", services: Layer.empty }))).toEqual([
			"services",
		]);
		expect(
			contributionKinds(definePlugin({ id: "t.landing", landing: { page: () => null } })),
		).toEqual(["landing"]);
	});

	it("surfaces generic contribution kinds under their kind id (P-070)", () => {
		expect(
			contributionKinds(
				definePlugin({
					id: "t.eval",
					contributions: [
						{ kind: "eval.stage", id: "s", version: "1" },
						{ kind: "eval.stage", id: "s2", version: "1" },
						{ kind: "eval.metric", id: "m", version: "1" },
					],
				}),
			),
		).toEqual(["eval.stage", "eval.metric"]);
	});
});

describe("missingRequiredDeps", () => {
	it("returns direct requiredDeps not in the enabled set", () => {
		const enabled = new Set(["t.a", "t.c", "t.d"]);
		// t.b requires t.a (enabled) → not missing.
		expect(missingRequiredDeps(plugins, enabled, "t.b")).toEqual([]);
		expect(missingRequiredDeps(plugins, new Set(["t.b", "t.c", "t.d"]), "t.b")).toEqual(["t.a"]);
		expect(missingRequiredDeps(plugins, enabled, "t.a")).toEqual([]);
		expect(missingRequiredDeps(plugins, enabled, "unknown")).toEqual([]);
	});
});

describe("dependentClosure / disabledClosure", () => {
	it("collects transitive dependents in registry order", () => {
		expect(dependentClosure(plugins, "t.a")).toEqual(["t.b", "t.c"]);
		expect(dependentClosure(plugins, "t.b")).toEqual(["t.c"]);
		expect(dependentClosure(plugins, "t.d")).toEqual([]);
		expect(disabledClosure(plugins, "t.a")).toEqual(["t.a", "t.b", "t.c"]);
		expect(disabledClosure(plugins, "t.d")).toEqual(["t.d"]);
	});

	it("handles diamonds without duplicates", () => {
		const diamond: readonly Plugin[] = [
			dep("t.a"),
			dep("t.b", ["t.a"]),
			dep("t.c", ["t.a"]),
			dep("t.d", ["t.b", "t.c"]),
		];
		expect(dependentClosure(diamond, "t.a")).toEqual(["t.b", "t.c", "t.d"]);
		expect(disabledClosure(diamond, "t.a")).toEqual(["t.a", "t.b", "t.c", "t.d"]);
	});
});

describe("requiredClosure", () => {
	it("walks requiredDeps transitively, deduplicated", () => {
		expect(requiredClosure(plugins, "t.c")).toEqual(["t.b", "t.a"]);
		expect(requiredClosure(plugins, "t.a")).toEqual([]);
	});

	it("deduplicates shared ancestors in a diamond", () => {
		// t.top requires both t.b and t.c; both require t.a — t.a must
		// appear once even though it is reachable twice.
		const diamond: readonly Plugin[] = [
			dep("t.a"),
			dep("t.b", ["t.a"]),
			dep("t.c", ["t.a"]),
			dep("t.top", ["t.b", "t.c"]),
		];
		expect(requiredClosure(diamond, "t.top")).toEqual(["t.b", "t.a", "t.c"]);
	});

	it("tolerates requiredDeps ids missing from the registry", () => {
		// A dep that no plugin declares still joins the closure; the
		// recursive visit finds no entry and stops.
		const sparse: readonly Plugin[] = [dep("t.top", ["t.ghost"])];
		expect(requiredClosure(sparse, "t.top")).toEqual(["t.ghost"]);
	});
});

describe("configFormFields", () => {
	// Hand-written JSON-Schema documents — the form consumes plain JSON,
	// never the effect/Schema itself.
	const doc = (schema: Record<string, unknown>): PluginConfigSchema => ({
		schema: { dialect: "draft-2020-12", schema, definitions: {} },
	});

	it("projects scalar properties into form fields", () => {
		const fields = configFormFields(
			doc({
				type: "object",
				required: ["title"],
				properties: {
					title: { type: "string", title: "Title" },
					retries: { type: "integer", title: "Retries", default: 3 },
					verbose: { type: "boolean", default: false },
					mode: { type: "string", enum: ["a", "b"], default: "a" },
				},
			}),
		);
		expect(fields).toEqual([
			{ key: "title", label: "Title", type: "string", required: true },
			{ key: "retries", label: "Retries", type: "number", default: 3, required: false },
			{ key: "verbose", label: "verbose", type: "boolean", default: false, required: false },
			{
				key: "mode",
				label: "mode",
				type: "enum",
				options: ["a", "b"],
				default: "a",
				required: false,
			},
		]);
	});

	it("skips unsupported shapes (anyOf/oneOf/const/nested/arrays)", () => {
		const fields = configFormFields(
			doc({
				type: "object",
				properties: {
					ok: { type: "string" },
					wrapped: { anyOf: [{ type: "number" }, { type: "string" }] },
					choice: { oneOf: [{ const: "x" }, { const: "y" }] },
					nested: { type: "object", properties: { a: { type: "string" } } },
					list: { type: "array", items: { type: "string" } },
					numEnum: { type: "number", enum: [1, 2] },
				},
			}),
		);
		expect(fields.map((f) => f.key)).toEqual(["ok"]);
	});

	it("skips non-object property entries", () => {
		const fields = configFormFields(
			doc({
				type: "object",
				properties: {
					ok: { type: "string" },
					// JSON-Schema allows boolean property schemas (`true` =
					// anything) — they carry no renderable type.
					anything: true,
					nothing: null,
				},
			}),
		);
		expect(fields.map((f) => f.key)).toEqual(["ok"]);
	});

	it("returns no fields for an empty or malformed document", () => {
		expect(configFormFields(doc({ type: "object" }))).toEqual([]);
		expect(
			configFormFields({ schema: { dialect: "draft-2020-12", schema: {}, definitions: {} } }),
		).toEqual([]);
	});
});

// ---------- plugins-map graph derivation (P-082) ----------

const chromePub = (id: string, regions: readonly string[]) =>
	definePlugin({
		id,
		chrome: regions.map((region, i) => ({
			id: `${id}.entry-${i}`,
			region,
			content: { kind: "link" as const, to: "/x", label: "X" },
		})),
	});

const edge = (g: ReturnType<typeof graphFromPlugins>, s: string, t: string, kind: string) =>
	g.edges.find((e) => e.source === s && e.target === t && e.kind === kind);

const edgesOf = (g: ReturnType<typeof graphFromPlugins>, kind: GraphEdge["kind"]) =>
	g.edges.filter((e) => e.kind === kind);

describe("regionEdgeTarget / kindConsumers", () => {
	it("routes owned region prefixes to their plugin, shared slots to pseudo-nodes", () => {
		expect(regionEdgeTarget("portal.dashboard.stats")).toBe("dashboard.panel");
		expect(regionEdgeTarget("portal.dashboard.sections")).toBe("dashboard.panel");
		expect(regionEdgeTarget("portal.sidebar")).toBe("region:portal.sidebar");
		expect(regionEdgeTarget("app.header.brand")).toBe("region:app.header.brand");
		// Unknown regions get a pseudo-node too — declared communication
		// is never dropped.
		expect(regionEdgeTarget("future.slot")).toBe("region:future.slot");
	});

	it("resolves contribution kinds to their collecting surfaces", () => {
		expect(kindConsumers("eval.stage")).toEqual(["eval-cli"]);
		expect(kindConsumers("eval.capability")).toEqual(["eval-cli"]);
		expect(kindConsumers("theme.tokens")).toEqual([
			"app-host.server",
			"app-host.client",
			"app.routes",
		]);
		// Unknown kinds fall back to the generic host surface.
		expect(kindConsumers("mystery.kind")).toEqual(["app-host.server"]);
	});
});

describe("graphFromPlugins", () => {
	it("draws required and optional dep edges dep → dependent", () => {
		const g = graphFromPlugins([
			dep("t.a"),
			dep("t.b", ["t.a"]),
			definePlugin({ id: "t.opt", optionalDeps: ["t.a"] }),
		]);
		expect(edge(g, "t.a", "t.b", "required")).toBeDefined();
		expect(edge(g, "t.a", "t.opt", "optional")).toBeDefined();
		expect(edgesOf(g, "required")).toHaveLength(1);
	});

	it("draws one region edge per plugin/region pair regardless of entry count", () => {
		const g = graphFromPlugins([
			chromePub("t.pub", ["portal.sidebar", "portal.sidebar", "portal.header.actions"]),
		]);
		const regionEdges = edgesOf(g, "region");
		expect(regionEdges).toHaveLength(2);
		expect(edge(g, "t.pub", "region:portal.sidebar", "region")?.label).toBe("portal.sidebar");
		expect(edge(g, "t.pub", "region:portal.header.actions", "region")).toBeDefined();
		// Pseudo-nodes materialize for both slots.
		expect(g.nodes.find((n) => n.id === "region:portal.sidebar")?.pseudo).toBe("region");
	});

	it("points chrome entries at owned slots' plugin when one declares them", () => {
		const g = graphFromPlugins([
			dep("dashboard.panel"),
			chromePub("t.pub", ["portal.dashboard.stats"]),
		]);
		expect(edge(g, "t.pub", "dashboard.panel", "region")?.label).toBe("portal.dashboard.stats");
		expect(g.nodes.some((n) => n.pseudo === "region")).toBe(false);
	});

	it("draws kind edges to each collecting surface of the kind", () => {
		const g = graphFromPlugins([
			definePlugin({
				id: "t.contrib",
				contributions: [{ kind: "eval.stage", id: "s", version: "1" }],
			}),
		]);
		expect(edge(g, "t.contrib", "surface:eval-cli", "kind")?.label).toBe("eval.stage");
		expect(g.nodes.find((n) => n.id === "surface:eval-cli")?.pseudo).toBe("surface");
	});

	it("marks every edge target as a node", () => {
		const g = graphFromPlugins([
			chromePub("t.pub", ["portal.sidebar"]),
			definePlugin({
				id: "t.contrib",
				contributions: [{ kind: "theme.tokens", id: "t", version: "1" }],
			}),
		]);
		const ids = new Set(g.nodes.map((n) => n.id));
		for (const e of g.edges) {
			expect(ids.has(e.source), `source ${e.source}`).toBe(true);
			expect(ids.has(e.target), `target ${e.target}`).toBe(true);
		}
	});
});

describe("layeredLayout / depths", () => {
	it("layers by longest dep path; pseudo-nodes one column past the deepest", () => {
		const g = graphFromPlugins([...plugins, chromePub("t.pub", ["portal.sidebar"])]);
		const depth = new Map(g.nodes.map((n) => [n.id, n.depth]));
		expect(depth.get("t.a")).toBe(0);
		expect(depth.get("t.b")).toBe(1);
		expect(depth.get("t.c")).toBe(2);
		expect(depth.get("t.pub")).toBe(0);
		expect(depth.get("region:portal.sidebar")).toBe(3); // max plugin depth (2) + 1
	});

	it("respects every required edge: depth(dep) < depth(dependent)", () => {
		const g = graphFromPlugins(plugins);
		const depth = new Map(g.nodes.map((n) => [n.id, n.depth]));
		for (const e of edgesOf(g, "required")) {
			expect(depth.get(e.source)!).toBeLessThan(depth.get(e.target)!);
		}
	});

	it("resolves deps declared out of topo order", () => {
		// The dependent lists first: its predecessors are visited
		// recursively, so their own loop turns are already memoized.
		const g = graphFromPlugins([dep("t.reorder.c", ["t.b"]), dep("t.a"), dep("t.b", ["t.a"])]);
		const depth = new Map(g.nodes.map((n) => [n.id, n.depth]));
		expect(depth.get("t.reorder.c")).toBe(2);
		expect(depth.get("t.b")).toBe(1);
		expect(depth.get("t.a")).toBe(0);
	});

	it("terminates on a dep cycle instead of recursing forever", () => {
		const g = graphFromPlugins([dep("t.x", ["t.y"]), dep("t.y", ["t.x"])]);
		const depth = new Map(g.nodes.map((n) => [n.id, n.depth]));
		expect(depth.get("t.x")).toBe(2);
		expect(depth.get("t.y")).toBe(1);
	});

	it("places columns by depth, rows in node order", () => {
		const g = graphFromPlugins(plugins);
		const layout = layeredLayout(g);
		expect(layout.positions.get("t.a")).toEqual({ x: 0, y: 0 });
		expect(layout.positions.get("t.d")).toEqual({ x: 0, y: 96 });
		expect(layout.positions.get("t.c")).toEqual({ x: 560, y: 0 });
		expect(layout.width).toBe(3);
	});
});

describe("focusNeighborhood", () => {
	const graph = graphFromPlugins([
		...plugins,
		chromePub("t.pub", ["portal.sidebar"]),
		dep("t.top", ["t.c"]),
	]);

	it("walks deps transitively both ways, plus direct channels", () => {
		const { upstream, downstream } = focusNeighborhood(graph, "t.b");
		expect([...upstream].sort()).toEqual(["t.a"]);
		expect([...downstream].sort()).toEqual(["t.c", "t.top"]);
		expect(upstream.has("t.b")).toBe(false);
		expect(downstream.has("t.b")).toBe(false);
	});

	it("includes channel endpoints: publishers downstream of their region", () => {
		const { downstream } = focusNeighborhood(graph, "region:portal.sidebar");
		expect(downstream.has("t.pub")).toBe(true);
		const { upstream } = focusNeighborhood(graph, "t.pub");
		expect(upstream.has("region:portal.sidebar")).toBe(true);
	});

	it("returns empty sets for isolated nodes", () => {
		const { upstream, downstream } = focusNeighborhood(graph, "t.d");
		expect(upstream.size).toBe(0);
		expect(downstream.size).toBe(0);
	});
});
