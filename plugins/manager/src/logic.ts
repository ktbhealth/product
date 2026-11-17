import type { Plugin, PluginConfigSchema } from "@ktb/kernel";

/**
 * Pure plugin-manager logic (P-058) — dep-graph walks and row derivation
 * shared by the /platform/plugins view. Everything here is plain data in,
 * plain data out: unit-tested without React or the app runtime.
 */

/** Display name for a plugin row: `meta.name` when declared, else id. */
export const pluginDisplayName = (plugin: Pick<Plugin, "id" | "meta">): string =>
	plugin.meta?.name ?? plugin.id;

/** Contribution kinds a plugin object carries — drives the "kinds" column. */
export const contributionKinds = (plugin: Plugin): readonly string[] => {
	const kinds: string[] = [];
	if (plugin.tables !== undefined) kinds.push("tables");
	if (plugin.services !== undefined) kinds.push("services");
	if (plugin.routes !== undefined) kinds.push("routes");
	if (plugin.landing !== undefined) kinds.push("landing");
	if (plugin.chrome !== undefined) kinds.push("chrome");
	if (plugin.panel !== undefined) kinds.push("panel");
	// Generic contribution kinds (P-070): entries on the `contributions`
	// channel surface under their registered kind id (e.g. "eval.stage").
	for (const entry of plugin.contributions ?? []) {
		if (!kinds.includes(entry.kind)) kinds.push(entry.kind);
	}
	return kinds;
};

/** Direct `requiredDeps` ids of `pluginId` that are NOT in `enabled` —
 * the "blocked" reason shown when enabling is refused. */
export const missingRequiredDeps = (
	plugins: readonly Plugin[],
	enabled: ReadonlySet<string>,
	pluginId: string,
): readonly string[] => {
	const plugin = plugins.find((p) => p.id === pluginId);
	return (plugin?.requiredDeps ?? []).filter((dep) => !enabled.has(dep));
};

/** Transitive `requiredDeps` closure of `pluginId` (excluding itself),
 * in declaration order, deduplicated. */
export const requiredClosure = (
	plugins: readonly Plugin[],
	pluginId: string,
): readonly string[] => {
	const byId = new Map(plugins.map((p) => [p.id, p] as const));
	const seen = new Set<string>();
	const out: string[] = [];
	const visit = (id: string) => {
		for (const dep of byId.get(id)?.requiredDeps ?? []) {
			if (seen.has(dep)) continue;
			seen.add(dep);
			out.push(dep);
			visit(dep);
		}
	};
	visit(pluginId);
	return out;
};

/**
 * Every plugin that transitively `requiredDep`s on `pluginId` — the
 * cascade set that must be disabled together with it (P-058). Excludes
 * `pluginId` itself; order follows registry (topo) order.
 */
export const dependentClosure = (
	plugins: readonly Plugin[],
	pluginId: string,
): readonly string[] => {
	const dependents = new Set<string>();
	let frontier = [pluginId];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const p of plugins) {
			if (dependents.has(p.id) || p.id === pluginId) continue;
			if ((p.requiredDeps ?? []).some((dep) => frontier.includes(dep))) {
				dependents.add(p.id);
				next.push(p.id);
			}
		}
		frontier = next;
	}
	return plugins.filter((p) => dependents.has(p.id)).map((p) => p.id);
};

/**
 * The full id set a disable of `pluginId` must send to
 * `setPluginEnabledFn`: the plugin plus every transitive dependent —
 * disabling a dep without its dependents would violate the
 * PluginStates dep invariant and be rejected server-side.
 */
export const disabledClosure = (
	plugins: readonly Plugin[],
	pluginId: string,
): readonly string[] => [pluginId, ...dependentClosure(plugins, pluginId)];

// ---------- generated config form (JSON Schema → fields) ----------

/** One renderable config field derived from the JSON-Schema document. */
export interface ConfigFormField {
	readonly key: string;
	/** `title` annotation when present, else the property key. */
	readonly label: string;
	readonly type: "string" | "number" | "boolean" | "enum";
	/** Allowed values for `type: "enum"`. */
	readonly options?: readonly string[];
	readonly default?: unknown;
	readonly required: boolean;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Project a plugin's `meta.config` JSON-Schema document into the flat
 * field list the generated settings form renders. v1 supports scalar
 * properties only: `type: "string" | "number" | "integer" | "boolean"`
 * and string `enum`s; anything else (`anyOf`/`oneOf`/`const`/nested
 * objects/arrays) is skipped — those plugins need a bespoke
 * `panel.settings` UI. `required` comes from the document's `required`
 * array; `default`/`title` from the property keywords.
 */
export const configFormFields = (config: PluginConfigSchema): readonly ConfigFormField[] => {
	const root = config.schema.schema;
	const properties = isPlainObject(root.properties) ? root.properties : {};
	const required = Array.isArray(root.required) ? root.required : [];
	const fields: ConfigFormField[] = [];
	for (const [key, prop] of Object.entries(properties)) {
		if (!isPlainObject(prop)) continue;
		const type = prop.type;
		const field: ConfigFormField = {
			key,
			label: typeof prop.title === "string" ? prop.title : key,
			required: required.includes(key),
			...("default" in prop ? { default: prop.default } : {}),
			type: "string",
		};
		if (Array.isArray(prop.enum)) {
			// String enums render as a Select; non-string enums have no
			// faithful v1 control — skip rather than degrade to a free input.
			if (prop.enum.every((o) => typeof o === "string")) {
				fields.push({ ...field, type: "enum", options: prop.enum as readonly string[] });
			}
			continue;
		}
		if (type === "boolean") {
			fields.push({ ...field, type: "boolean" });
		} else if (type === "number" || type === "integer") {
			fields.push({ ...field, type: "number" });
		} else if (type === "string") {
			fields.push(field);
		}
		// Unsupported shapes are skipped entirely (see doc comment).
	}
	return fields;
};

// ---------- plugins-map graph derivation (P-082) ----------

/**
 * Structural graph of the plugin registry for the map view — every
 * `Plugin` object is a node; declared relationships are edges. All
 * derivation is manifest-only: `requiredDeps`/`optionalDeps` order the
 * graph, `chrome[].region` shows which named slots a plugin publishes
 * into, and generic `contributions[]` entries point at the surfaces
 * that collect their kind.
 */

export type GraphEdgeKind = "required" | "optional" | "region" | "kind";

export interface GraphEdge {
	readonly source: string;
	readonly target: string;
	readonly kind: GraphEdgeKind;
	/** The concrete slot/kind behind the edge — region name or
	 * contribution kind id; undefined for dep edges. */
	readonly label?: string;
}

export type PseudoNodeKind = "region" | "surface";

export interface GraphNode {
	readonly id: string;
	/** Display label — plugin id, region name, or surface name. */
	readonly label: string;
	/** Present for real plugin nodes; absent on pseudo-nodes. */
	readonly plugin?: Plugin;
	readonly pseudo?: PseudoNodeKind;
	/** Longest-path layer over dep edges (0 = no deps). Pseudo-nodes
	 * sit one column past the deepest plugin. */
	readonly depth: number;
}

export interface PluginGraph {
	readonly nodes: readonly GraphNode[];
	readonly edges: readonly GraphEdge[];
}

export const regionNodeId = (region: string): string => `region:${region}`;
export const surfaceNodeId = (consumer: string): string => `surface:${consumer}`;

/** Region prefixes whose slots are declared AND rendered by a plugin —
 * region edges point at that plugin rather than a `region:` pseudo-node.
 * Shared slots (`portal.*` chrome, `app.*` chrome) are rendered by
 * whichever shell is active, so they keep a pseudo-node each. */
const REGION_OWNERS: readonly (readonly [string, string])[] = [
	["portal.dashboard.", "dashboard.panel"],
];

/** The node a `chrome[].region` edge targets: the owning plugin when
 * one declares the slot, else a `region:` pseudo-node. Unknown regions
 * still get a node — the map never hides declared communication. */
export const regionEdgeTarget = (region: string): string =>
	REGION_OWNERS.find(([prefix]) => region.startsWith(prefix))?.[1] ?? regionNodeId(region);

/** Generic-contribution kind prefixes → the surfaces that collect
 * them. Mirrors the `consumers` field of the kind descriptors
 * (`EVAL_CONTRIBUTION_KINDS` in @ktb/eval-core, `THEME_*_KIND` in
 * @ktb/kernel) — kept as a static table so the manager does not import
 * domain packages just for descriptors. A registry-level test asserts
 * every used kind resolves here, so a new kind forces this table (and
 * its consumer list) to be revisited instead of silently degrading. */
const KIND_CONSUMERS: readonly (readonly [string, readonly string[]])[] = [
	["eval.", ["eval-cli"]],
	["theme.", ["app-host.server", "app-host.client", "app.routes"]],
];

/** Every kind consumer is a host surface today — the KIND_CONSUMERS
 * table only names surfaces (`eval-cli`, `app-host.*`, `app.routes`),
 * so edges always land on a `surface:` pseudo-node. */
const consumerEdgeTarget = (consumer: string): string => surfaceNodeId(consumer);

/** Surfaces collecting `kind` — falls back to the generic host surface
 * for kinds no table claims. */
export const kindConsumers = (kind: string): readonly string[] =>
	KIND_CONSUMERS.find(([prefix]) => kind.startsWith(prefix))?.[1] ?? ["app-host.server"];

/**
 * Derive the map's nodes and edges from the registry. `requiredDeps`
 * and `optionalDeps` edges run dep → dependent (same orientation as
 * `orderPlugins`); `region`/`kind` edges run plugin → consumer.
 * Parallel same-kind edges between a pair collapse into one — a plugin
 * publishing five chrome entries into `portal.sidebar` draws a single
 * edge labeled with the region.
 */
export const graphFromPlugins = (plugins: readonly Plugin[]): PluginGraph => {
	const nodes = new Map<string, GraphNode>();
	const edges = new Map<string, GraphEdge>();
	const addEdge = (edge: GraphEdge) => {
		const key = `${edge.source}\0${edge.kind}\0${edge.target}\0${edge.label ?? ""}`;
		if (!edges.has(key)) edges.set(key, edge);
	};
	for (const plugin of plugins) {
		nodes.set(plugin.id, { id: plugin.id, label: plugin.id, plugin, depth: 0 });
		for (const dep of plugin.requiredDeps ?? []) {
			addEdge({ source: dep, target: plugin.id, kind: "required" });
		}
		for (const dep of plugin.optionalDeps ?? []) {
			addEdge({ source: dep, target: plugin.id, kind: "optional" });
		}
		for (const entry of plugin.chrome ?? []) {
			const target = regionEdgeTarget(entry.region);
			addEdge({ source: plugin.id, target, kind: "region", label: entry.region });
		}
		for (const entry of plugin.contributions ?? []) {
			for (const consumer of kindConsumers(entry.kind)) {
				addEdge({
					source: plugin.id,
					target: consumerEdgeTarget(consumer),
					kind: "kind",
					label: entry.kind,
				});
			}
		}
	}
	// Materialize pseudo-nodes for every edge target that is not a
	// plugin id — a target without a node would render nothing.
	for (const edge of edges.values()) {
		if (!nodes.has(edge.target)) {
			const pseudo: PseudoNodeKind = edge.target.startsWith("region:") ? "region" : "surface";
			const label = edge.target.slice(pseudo.length + 1);
			nodes.set(edge.target, { id: edge.target, label, pseudo, depth: 0 });
		}
	}
	return { nodes: assignDepths(nodes, edges), edges: [...edges.values()] };
};

/** Longest-path depth over required+optional edges: depth(p) = 0 with
 * no dep predecessors, else 1 + max(depth of predecessors). Registry
 * order feeds the walk (topo already), so a single pass suffices.
 * Pseudo-nodes are placed one column past the deepest plugin — they
 * are sinks of the communication flow, not part of composition. */
const assignDepths = (
	nodes: Map<string, GraphNode>,
	edges: Map<string, GraphEdge>,
): readonly GraphNode[] => {
	const incoming = new Map<string, string[]>();
	for (const edge of edges.values()) {
		if (edge.kind !== "required" && edge.kind !== "optional") continue;
		incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
	}
	const depth = new Map<string, number>();
	for (const id of nodes.keys()) {
		if (!depth.has(id)) {
			const visit = (n: string, trail: ReadonlySet<string>): number => {
				const memo = depth.get(n);
				if (memo !== undefined) return memo;
				if (trail.has(n)) return 0;
				const preds = incoming.get(n) ?? [];
				const d =
					preds.length === 0
						? 0
						: 1 + Math.max(...preds.map((p) => visit(p, new Set([...trail, n]))));
				depth.set(n, d);
				return d;
			};
			visit(id, new Set());
		}
	}
	const maxPluginDepth = Math.max(
		0,
		// Every node id is visited above, so plugin depths are always set.
		...[...nodes.values()].filter((n) => n.pseudo === undefined).map((n) => depth.get(n.id)!),
	);
	return [...nodes.values()].map((node) => ({
		...node,
		depth: node.pseudo === undefined ? depth.get(node.id)! : maxPluginDepth + 1,
	}));
};

export interface GraphLayout {
	readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
	readonly width: number;
	readonly height: number;
}

export const LAYOUT_COLUMN_WIDTH = 280;
export const LAYOUT_ROW_HEIGHT = 96;

/**
 * Deterministic layered layout, no dependencies: x = depth × column
 * width, y = order within the layer following node order (registry
 * topo for plugin nodes, discovery order for pseudo-nodes).
 */
export const layeredLayout = (graph: PluginGraph): GraphLayout => {
	const byDepth = new Map<number, GraphNode[]>();
	for (const node of graph.nodes) {
		byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node]);
	}
	const positions = new Map<string, { x: number; y: number }>();
	let height = 0;
	for (const [depth, layer] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
		height = Math.max(height, layer.length);
		layer.forEach((node, index) => {
			positions.set(node.id, { x: depth * LAYOUT_COLUMN_WIDTH, y: index * LAYOUT_ROW_HEIGHT });
		});
	}
	return {
		positions,
		width: byDepth.size,
		height,
	};
};

/**
 * The transitive neighborhood of `id` over ALL edge kinds:
 * `upstream` = everything the node consumes (deps, regions it
 * publishes into are excluded — regions are written TO, not read),
 * `downstream` = everything that depends on or consumes it. Dep edges
 * walk transitively; region/kind edges contribute their direct
 * endpoints only. Includes `id` itself in neither set.
 */
export const focusNeighborhood = (
	graph: PluginGraph,
	id: string,
): { readonly upstream: ReadonlySet<string>; readonly downstream: ReadonlySet<string> } => {
	const depOut = new Map<string, string[]>();
	const depIn = new Map<string, string[]>();
	const direct = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (edge.kind === "required" || edge.kind === "optional") {
			depOut.set(edge.source, [...(depOut.get(edge.source) ?? []), edge.target]);
			depIn.set(edge.target, [...(depIn.get(edge.target) ?? []), edge.source]);
		}
		direct.set(edge.source, [...(direct.get(edge.source) ?? []), edge.target]);
		direct.set(edge.target, [...(direct.get(edge.target) ?? []), edge.source]);
	}
	const walk = (
		starts: readonly string[],
		next: (id: string) => readonly string[],
	): Set<string> => {
		const seen = new Set<string>();
		const queue = [...starts];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (seen.has(current) || current === id) continue;
			seen.add(current);
			queue.push(...next(current));
		}
		return seen;
	};
	// Upstream: transitive dep predecessors + direct channel targets
	// (the surfaces this node publishes into).
	const upstream = walk(depIn.get(id) ?? [], (n) => depIn.get(n) ?? []);
	for (const t of direct.get(id) ?? []) {
		const edge = graph.edges.find((e) => e.source === id && e.target === t);
		if (edge !== undefined && edge.kind !== "required" && edge.kind !== "optional") {
			upstream.add(t);
		}
	}
	// Downstream: transitive dep dependents + direct channel sources
	// (plugins publishing into this node's region).
	const downstream = walk(depOut.get(id) ?? [], (n) => depOut.get(n) ?? []);
	for (const s of graph.edges.filter(
		(e) => e.target === id && (e.kind === "region" || e.kind === "kind"),
	)) {
		downstream.add(s.source);
	}
	return { upstream, downstream };
};
