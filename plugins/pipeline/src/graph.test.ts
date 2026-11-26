import { describe, expect, it } from "vitest";

import type { OrchestrationDef, OrchestrationNode } from "@ktb/orchestrator";

import {
	addNode,
	connectNodes,
	deriveGraph,
	nextNodeId,
	ORCHESTRATOR_NODE_ID,
	removeNode,
	sharedEventTypes,
	suggestEventType,
	updateNode,
} from "./graph.ts";

const node = (partial: Partial<OrchestrationNode> & { id: string }): OrchestrationNode => ({
	kind: "emit",
	on: [],
	emits: [],
	...partial,
});

const def = (nodes: readonly OrchestrationNode[]): OrchestrationDef => ({
	id: "demo",
	nodes,
});

describe("sharedEventTypes", () => {
	it("returns the intersection of emits and on", () => {
		expect(sharedEventTypes({ emits: ["a", "b", "c"] }, { on: ["b", "c", "d"] })).toEqual([
			"b",
			"c",
		]);
	});

	it("returns empty when nothing overlaps", () => {
		expect(sharedEventTypes({ emits: ["a"] }, { on: ["b"] })).toEqual([]);
	});
});

describe("deriveGraph", () => {
	it("derives an edge per emits∩on pair, direction emitter→subscriber", () => {
		const g = deriveGraph(
			def([
				node({ id: "a", emits: ["done", "failed"] }),
				node({ id: "b", on: ["done"] }),
				node({ id: "c", on: ["done", "failed"] }),
			]),
		);
		expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
		expect(g.edges).toEqual([
			{ id: "a->b", source: "a", target: "b", eventTypes: ["done"] },
			{ id: "a->c", source: "a", target: "c", eventTypes: ["done", "failed"] },
		]);
	});

	it("produces no edges and no pseudo-node for an empty def", () => {
		const g = deriveGraph(def([]));
		expect(g.nodes).toEqual([]);
		expect(g.edges).toEqual([]);
	});

	it("adds the orchestrator pseudo-node only for subscribed lifecycle types", () => {
		const g = deriveGraph(
			def([node({ id: "a", on: ["start", "workflow.done"] }), node({ id: "b", on: ["start"] })]),
		);
		expect(g.nodes[0]).toMatchObject({
			id: ORCHESTRATOR_NODE_ID,
			kind: "orchestrator",
			pseudo: true,
			emits: ["start", "workflow.done"],
		});
		expect(g.edges).toEqual([
			{
				id: "orchestrator->a",
				source: "orchestrator",
				target: "a",
				eventTypes: ["start", "workflow.done"],
			},
			{
				id: "orchestrator->b",
				source: "orchestrator",
				target: "b",
				eventTypes: ["start"],
			},
		]);
	});

	it("does not add the pseudo-node when nothing subscribes to lifecycle types", () => {
		const g = deriveGraph(def([node({ id: "a", on: ["custom"], emits: ["custom"] })]));
		expect(g.nodes.some((n) => n.pseudo)).toBe(false);
	});

	it("self-loops never derive (a node cannot subscribe to itself)", () => {
		const g = deriveGraph(def([node({ id: "a", on: ["x"], emits: ["x"] })]));
		expect(g.edges).toEqual([]);
	});
});

describe("connectNodes", () => {
	it("appends the event type to source.emits and target.on", () => {
		const d = def([node({ id: "a" }), node({ id: "b" })]);
		const next = connectNodes(d, "a", "b", "a.done");
		expect(next.nodes[0]?.emits).toEqual(["a.done"]);
		expect(next.nodes[1]?.on).toEqual(["a.done"]);
		// The derived graph now shows the edge.
		expect(deriveGraph(next).edges.map((e) => e.id)).toEqual(["a->b"]);
	});

	it("is idempotent for an already-shared type", () => {
		const d = def([node({ id: "a", emits: ["x"] }), node({ id: "b", on: ["x"] })]);
		const next = connectNodes(d, "a", "b", "x");
		expect(next.nodes[0]?.emits).toEqual(["x"]);
		expect(next.nodes[1]?.on).toEqual(["x"]);
	});

	it("refuses the orchestrator pseudo-node and unknown ids", () => {
		const d = def([node({ id: "a" }), node({ id: "b" })]);
		expect(connectNodes(d, ORCHESTRATOR_NODE_ID, "b", "x")).toBe(d);
		expect(connectNodes(d, "a", "nope", "x")).toBe(d);
		expect(connectNodes(d, "a", "a", "x")).toBe(d);
		expect(connectNodes(d, "a", "b", "  ")).toBe(d);
	});
});

describe("node edits", () => {
	it("addNode appends and rejects duplicate ids", () => {
		const d = def([node({ id: "a" })]);
		const next = addNode(d, node({ id: "b" }));
		expect(next.nodes.map((n) => n.id)).toEqual(["a", "b"]);
		expect(() => addNode(next, node({ id: "b" }))).toThrow(/already has a node/);
	});

	it("removeNode drops the node; updateNode merges a patch", () => {
		const d = def([node({ id: "a", on: ["x"] }), node({ id: "b" })]);
		expect(removeNode(d, "b").nodes.map((n) => n.id)).toEqual(["a"]);
		expect(removeNode(d, "nope").nodes).toHaveLength(2);
		const patched = updateNode(d, "a", { kind: "ai", emits: ["y"] });
		expect(patched.nodes[0]).toMatchObject({ id: "a", kind: "ai", emits: ["y"], on: ["x"] });
		expect(updateNode(d, "nope", { kind: "ai" }).nodes).toEqual(d.nodes);
	});

	it("nextNodeId finds the first free kind-n id", () => {
		const d = def([node({ id: "ai-1" }), node({ id: "ai-3" })]);
		expect(nextNodeId(d, "ai")).toBe("ai-2");
		expect(nextNodeId(def([]), "gate")).toBe("gate-1");
	});
});

describe("suggestEventType", () => {
	it("reuses an already-shared type when the pair is wired", () => {
		const d = def([node({ id: "a", emits: ["done"] }), node({ id: "b", on: ["done"] })]);
		expect(suggestEventType(d, "a", "b")).toBe("done");
	});

	it("suggests a readable slug for unwired pairs", () => {
		const d = def([node({ id: "a", kind: "ai" }), node({ id: "b", kind: "gate" })]);
		expect(suggestEventType(d, "a", "b")).toBe("flow.ai.gate");
		expect(suggestEventType(d, "a", "nope")).toBe("");
	});
});
