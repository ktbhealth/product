import type { OrchestrationDef, OrchestrationNode } from "@ktb/orchestrator";

/**
 * graph.ts — the def↔graph derivation for the pipelines admin editor
 * (P-120 phase 4). `OrchestrationDef` stores NO edges: routing emerges
 * from each node's `on` event-type subscriptions intersecting other
 * nodes' `emits`. This module is the pure, framework-free half — the
 * React Flow view maps its output onto flow nodes/edges and calls the
 * edit helpers to produce the next def. Everything here is unit-tested
 * in node (no DOM, no xyflow import).
 */

/** Pseudo-node id for lifecycle/synthetic events emitted by the
 * runner itself (source "orchestrator" in OrchestrationEvent terms). */
export const ORCHESTRATOR_NODE_ID = "orchestrator";

/** Event types the orchestrator itself can emit — the seed `start`
 * plus the `workflow.*`/`node.*`/`event.*` lifecycle vocabulary from
 * `OrchestrationEvent`. A node subscribing to any of these gets a
 * derived edge from the pseudo-node. */
const ORCHESTRATOR_EVENT_TYPES: readonly string[] = [
	"start",
	"workflow.done",
	"workflow.failed",
	"workflow.cancel",
	"node.failed",
	"node.exhausted",
	"event.invalid",
];

/** One rendered graph node: a def entry, or the lifecycle pseudo-node
 * when some def node subscribes to orchestrator-emitted types. */
export interface DerivedNode {
	readonly id: string;
	readonly kind: string;
	readonly on: readonly string[];
	readonly emits: readonly string[];
	/** True for the synthetic orchestrator source — never a def node. */
	readonly pseudo: boolean;
}

/** One derived edge: `source` → `target` carrying every event type in
 * `source.emits ∩ target.on` (the def has no edge objects — this IS
 * the edge). */
interface DerivedEdge {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	readonly eventTypes: readonly string[];
}

export interface DerivedGraph {
	readonly nodes: readonly DerivedNode[];
	readonly edges: readonly DerivedEdge[];
}

/** The event types `a` emits that `b` subscribes to — the routing
 * rule, exposed for tests and the connect dialog's "already wired?"
 * check. */
export const sharedEventTypes = (
	a: Pick<OrchestrationNode, "emits">,
	b: Pick<OrchestrationNode, "on">,
): readonly string[] => {
	const on = new Set(b.on);
	return a.emits.filter((type) => on.has(type));
};

/**
 * Derive the render graph from a def. Edges run source→target for
 * every ordered pair where `emits ∩ on ≠ ∅` — direction follows event
 * flow (emitter → subscriber). When at least one node subscribes to an
 * orchestrator-emitted type, a pseudo "orchestrator" node is prepended
 * carrying exactly the subscribed lifecycle types as its `emits`.
 */
export const deriveGraph = (def: OrchestrationDef): DerivedGraph => {
	const nodes: DerivedNode[] = def.nodes.map((node) => ({
		id: node.id,
		kind: node.kind,
		on: node.on,
		emits: node.emits,
		pseudo: false,
	}));

	const lifecycleEmits = ORCHESTRATOR_EVENT_TYPES.filter((type) =>
		def.nodes.some((node) => node.on.includes(type)),
	);
	if (lifecycleEmits.length > 0) {
		nodes.unshift({
			id: ORCHESTRATOR_NODE_ID,
			kind: "orchestrator",
			on: [],
			emits: lifecycleEmits,
			pseudo: true,
		});
	}

	const edges: DerivedEdge[] = [];
	for (const source of nodes) {
		for (const target of nodes) {
			if (source.id === target.id) continue;
			const eventTypes = sharedEventTypes(source, target);
			if (eventTypes.length === 0) continue;
			edges.push({
				id: `${source.id}->${target.id}`,
				source: source.id,
				target: target.id,
				eventTypes,
			});
		}
	}
	return { nodes, edges };
};

const pushUnique = (list: readonly string[], value: string): readonly string[] =>
	list.includes(value) ? list : [...list, value];

/**
 * The connect gesture's payload: append `eventType` to `sourceId`'s
 * `emits` and `targetId`'s `on` (dedup'd — re-connecting an existing
 * type is a no-op). Returns the def unchanged when either endpoint is
 * the orchestrator pseudo-node (lifecycle edges are derived, not
 * authored) or the ids don't resolve.
 */
export const connectNodes = (
	def: OrchestrationDef,
	sourceId: string,
	targetId: string,
	eventType: string,
): OrchestrationDef => {
	if (sourceId === ORCHESTRATOR_NODE_ID || eventType.trim() === "") return def;
	const source = def.nodes.find((n) => n.id === sourceId);
	const target = def.nodes.find((n) => n.id === targetId);
	if (source === undefined || target === undefined || sourceId === targetId) return def;
	return {
		...def,
		nodes: def.nodes.map((node) => {
			if (node.id === sourceId) return { ...node, emits: pushUnique(node.emits, eventType) };
			if (node.id === targetId) return { ...node, on: pushUnique(node.on, eventType) };
			return node;
		}),
	};
};

/** Append a node. Throws on a duplicate id — node ids are the def's
 * identity surface (state keys, run records), collisions are a
 * programming error, not a merge. */
export const addNode = (def: OrchestrationDef, node: OrchestrationNode): OrchestrationDef => {
	if (def.nodes.some((n) => n.id === node.id)) {
		throw new Error(`orchestration ${def.id} already has a node "${node.id}"`);
	}
	return { ...def, nodes: [...def.nodes, node] };
};

/** Remove a node by id; unknown ids leave the def unchanged. */
export const removeNode = (def: OrchestrationDef, nodeId: string): OrchestrationDef => ({
	...def,
	nodes: def.nodes.filter((n) => n.id !== nodeId),
});

/** Shallow-merge a patch into one node; unknown ids leave the def
 * unchanged. */
export const updateNode = (
	def: OrchestrationDef,
	nodeId: string,
	patch: Partial<OrchestrationNode>,
): OrchestrationDef => ({
	...def,
	nodes: def.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
});

/** First free `${kind}-${n}` id for palette-added nodes. */
export const nextNodeId = (def: OrchestrationDef, kind: string): string => {
	const taken = new Set(def.nodes.map((n) => n.id));
	for (let i = 1; ; i++) {
		const candidate = `${kind}-${i}`;
		if (!taken.has(candidate)) return candidate;
	}
};

/** Suggested event type for a connect gesture: reuse an already-shared
 * type when one exists (the pair is wired — the dialog still lets the
 * admin pick another), otherwise a readable `flow.<source>.<target>`
 * slug. */
export const suggestEventType = (
	def: OrchestrationDef,
	sourceId: string,
	targetId: string,
): string => {
	const source = def.nodes.find((n) => n.id === sourceId);
	const target = def.nodes.find((n) => n.id === targetId);
	if (source === undefined || target === undefined) return "";
	const existing = sharedEventTypes(source, target);
	if (existing.length > 0) return existing[0] ?? "";
	const slug = (id: string) => id.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return `flow.${slug(source.kind)}.${slug(target.kind)}`;
};
