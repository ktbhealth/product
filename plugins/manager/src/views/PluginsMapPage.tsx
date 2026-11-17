import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
	parseAsArrayOf,
	parseAsBoolean,
	parseAsString,
	parseAsStringLiteral,
	useQueryState,
} from "nuqs";
import {
	Handle,
	MarkerType,
	MiniMap,
	Position,
	ReactFlowProvider,
	useReactFlow,
	type Edge,
	type Node as FlowNode,
	type NodeProps,
} from "@xyflow/react";
import {
	ChevronDownIcon,
	LayersIcon,
	LayoutGridIcon,
	Maximize2Icon,
	Minimize2Icon,
	NetworkIcon,
	WaypointsIcon,
} from "lucide-react";

import { Canvas } from "@ktbhealth/ui/components/ai-elements/canvas";
import { Controls } from "@ktbhealth/ui/components/ai-elements/controls";
import { Panel } from "@ktbhealth/ui/components/ai-elements/panel";
import {
	Node,
	NodeContent,
	NodeHeader,
	NodeTitle,
} from "@ktbhealth/ui/components/ai-elements/node";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ktbhealth/ui/components/sheet";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Switch } from "@ktbhealth/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@ktbhealth/ui/components/toggle-group";
import { cn } from "@ktbhealth/ui/lib/utils";
import type { Plugin } from "@ktb/kernel";
import type { ElkNode } from "elkjs";

import {
	focusNeighborhood,
	graphFromPlugins,
	layeredLayout,
	pluginDisplayName,
	LAYOUT_ROW_HEIGHT,
	type GraphEdge,
	type GraphNode,
	type PluginGraph,
} from "../logic.ts";
import type { ManagerMessages } from "../i18n.ts";

const MAP_VIEWS = ["dependencies", "channels", "domains", "hierarchy"] as const;
export type MapView = (typeof MAP_VIEWS)[number];
export type MapStatus = "enabled" | "disabled" | "blocked" | "system";
const STATUS_PARAMS = ["enabled", "disabled", "blocked", "system"] as const;

type PluginFlowNodeData = {
	node: GraphNode;
	displayName: string;
	status: MapStatus;
	/** Transitive dep-dependents — powers the branch collapse toggle. */
	branchCount: number;
	collapsed: boolean;
	onToggleCollapse: (id: string) => void;
};
type PluginFlowNode = FlowNode<PluginFlowNodeData, "plugin">;
type PseudoFlowNode = FlowNode<{ node: GraphNode }, "pseudo">;
type LaneFlowNode = FlowNode<{ label: string }, "lane">;
/** Virtual node for a dot-notation prefix shared by ≥2 plugins —
 * the single parent/source of everything under `ns:<prefix>`. */
type NsFlowNode = FlowNode<
	{
		label: string;
		memberCount: number;
		collapsed: boolean;
		onToggleCollapse: (id: string) => void;
	},
	"ns"
>;
type MapFlowNode = PluginFlowNode | PseudoFlowNode | LaneFlowNode | NsFlowNode;

const STATUS_DOT: Record<MapStatus, string> = {
	enabled: "bg-primary",
	system: "bg-primary",
	disabled: "bg-muted-foreground/50",
	blocked: "bg-destructive",
};

const EDGE_STYLE: Record<
	GraphEdge["kind"],
	{ stroke: string; strokeWidth: number; strokeDasharray?: string }
> = {
	required: { stroke: "var(--primary)", strokeWidth: 1.5 },
	optional: { stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "6 4" },
	region: { stroke: "var(--chart-2)", strokeWidth: 1, strokeDasharray: "2 4" },
	kind: { stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "1 4" },
};

// Domains view swimlane metrics.
const LANE_COL_W = 240;
const LANE_COLS = 4;
const LANE_PAD_X = 16;
const LANE_HEADER_H = 52;
const LANE_GAP = 24;

const isPluginNode = (n: GraphNode): boolean => n.pseudo === undefined;

// Dim state lives outside node data: hover/search changes it every
// frame, and rebuilding the nodes array makes React Flow re-measure
// everything (the visible "flicker"). Node views read their dim flag
// from this context instead — the nodes prop stays referentially
// stable across hovers.
const DimContext = createContext<ReadonlyMap<string, boolean>>(new Map());
const useDimmed = (id: string): boolean => useContext(DimContext).get(id) === true;

const domainOf = (node: GraphNode): string => node.plugin?.meta?.keywords?.[0] ?? "platform";

/** Every namespace prefix in an id's dot chain, root-first
 * (`a.b.c` → `["a", "a.b"]`). */
const nsChain = (id: string): string[] => {
	const parts = id.split(".");
	const chain: string[] = [];
	for (let i = 1; i < parts.length; i++) chain.push(parts.slice(0, i).join("."));
	return chain;
};

/** Containment edges `ns:parent → child` in the Hierarchy view —
 * thin and arrow-less so they read as structure, not deps. */
const TREE_EDGE_STYLE = { stroke: "var(--muted-foreground)", strokeWidth: 1 } as const;

/**
 * Shape of the Hierarchy view: plugins plus one virtual `ns:` node
 * per dot-prefix shared by ≥2 members. A collapsed ns keeps its
 * node (rendered as "+N") even with all members hidden; an ns that
 * loses every member through other collapses is pruned.
 */
const hierarchyShape = (
	graph: PluginGraph,
	hidden: ReadonlySet<string>,
	collapsed: ReadonlySet<string>,
) => {
	const allMembers = graph.nodes.filter(isPluginNode);
	const members = allMembers.filter((n) => !hidden.has(n.id));
	const prefixCount = new Map<string, number>();
	for (const n of allMembers) {
		for (const ns of nsChain(n.id)) prefixCount.set(ns, (prefixCount.get(ns) ?? 0) + 1);
	}
	const nsIds = new Set<string>();
	for (const [prefix, count] of prefixCount) {
		if (count < 2) continue;
		const hasVisibleMember = members.some((m) => m.id.startsWith(`${prefix}.`));
		if (hasVisibleMember || collapsed.has(`ns:${prefix}`)) nsIds.add(prefix);
	}
	return { members, nsIds, prefixCount };
};

/** Deepest shared prefix of `id` — its virtual parent node (or
 * null for root-level ids). Accepts ns prefixes too: `nsParent`
 * of `a.b` is `ns:a` when `a` is also a shared prefix. */
const nsParent = (id: string, nsIds: ReadonlySet<string>): string | null => {
	const chain = nsChain(id);
	for (let i = chain.length - 1; i >= 0; i--) {
		if (nsIds.has(chain[i])) return `ns:${chain[i]}`;
	}
	return null;
};

/**
 * Lift an edge endpoint to its deepest RENDERED ns that does NOT
 * contain the other endpoint — the ns node becomes the single
 * connection hub for everything inside it. `a.b.x → a.c.y` lifts
 * to `ns:a.b → ns:a.c`; `a.x → a.y` stays member-level under `ns:a`.
 */
const liftToNs = (id: string, other: string, nsIds: ReadonlySet<string>): string => {
	const chain = nsChain(id);
	for (let i = chain.length - 1; i >= 0; i--) {
		if (nsIds.has(chain[i]) && !other.startsWith(`${chain[i]}.`)) return `ns:${chain[i]}`;
	}
	return id;
};

type LiftedEdge = {
	source: string;
	target: string;
	kind: GraphEdge["kind"];
	count: number;
};

/**
 * Dep edges with endpoints lifted to ns hubs and duplicates merged
 * (the ×N count). Endpoints are checked AFTER lifting, so an edge
 * from a member hidden inside a collapsed ns still connects at the
 * hub; an edge whose effective endpoint vanished is dropped.
 */
const liftedDepEdges = (
	graph: PluginGraph,
	nsIds: ReadonlySet<string>,
	hidden: ReadonlySet<string>,
): LiftedEdge[] => {
	const shown = (id: string): boolean =>
		id.startsWith("ns:") ? nsIds.has(id.slice(3)) : !hidden.has(id);
	const map = new Map<string, LiftedEdge>();
	for (const e of graph.edges) {
		if (e.kind !== "required" && e.kind !== "optional") continue;
		const source = liftToNs(e.source, e.target, nsIds);
		const target = liftToNs(e.target, e.source, nsIds);
		if (source === target || !shown(source) || !shown(target)) continue;
		const key = `${source}#${target}#${e.kind}`;
		const prev = map.get(key);
		if (prev !== undefined) prev.count += 1;
		else map.set(key, { source, target, kind: e.kind, count: 1 });
	}
	return [...map.values()];
};

const flowEdgeOf = (edge: GraphEdge, enabledSet: ReadonlySet<string>): Edge => {
	const style = { ...EDGE_STYLE[edge.kind] };
	// A required edge from a disabled dep is the "blocked" channel —
	// tint it destructive so the dependency view answers "what's off".
	if (edge.kind === "required" && !enabledSet.has(edge.source)) {
		style.stroke = "var(--destructive)";
	}
	return {
		id: `${edge.source}->${edge.target}:${edge.kind}:${edge.label ?? ""}`,
		source: edge.source,
		target: edge.target,
		label: edge.kind === "region" || edge.kind === "kind" ? edge.label : undefined,
		style,
		markerEnd:
			edge.kind === "required" ? { type: MarkerType.ArrowClosed, color: style.stroke } : undefined,
	};
};

/**
 * Project the PluginGraph into React Flow nodes/edges for one view.
 * Pure — the component feeds status/dim lookups; everything
 * view-specific (swimlane geometry, channel filtering) lives here.
 */
export const buildFlow = (
	graph: PluginGraph,
	view: MapView,
	statusById: ReadonlyMap<string, MapStatus>,
	enabledSet: ReadonlySet<string>,
	opts: {
		/** Nodes hidden by branch collapse — skipped with their edges. */
		hidden?: ReadonlySet<string>;
		collapsed?: ReadonlySet<string>;
		onToggleCollapse: (id: string) => void;
	},
): { nodes: MapFlowNode[]; edges: Edge[] } => {
	const hidden = opts.hidden ?? new Set<string>();
	const collapsed = opts.collapsed ?? new Set<string>();
	const onToggleCollapse = opts.onToggleCollapse;
	const pluginData = (node: GraphNode): PluginFlowNodeData => ({
		node,
		// Only plugin nodes reach pluginData, so `plugin` is defined.
		displayName: pluginDisplayName(node.plugin!),
		status: statusById.get(node.id) ?? "enabled",
		branchCount: focusNeighborhood(graph, node.id).downstream.size,
		collapsed: collapsed.has(node.id),
		onToggleCollapse,
	});
	if (view === "hierarchy") {
		const { members, nsIds, prefixCount } = hierarchyShape(graph, hidden, collapsed);
		const nodes: MapFlowNode[] = [...nsIds]
			.sort((a, b) => a.split(".").length - b.split(".").length || a.localeCompare(b))
			.map((ns) => ({
				id: `ns:${ns}`,
				type: "ns" as const,
				position: { x: 0, y: 0 },
				data: {
					label: ns,
					memberCount: prefixCount.get(ns)!,
					collapsed: collapsed.has(`ns:${ns}`),
					onToggleCollapse,
				},
				draggable: false,
			}));
		for (const n of members) {
			nodes.push({
				id: n.id,
				type: "plugin",
				position: { x: 0, y: 0 },
				data: pluginData(n),
			});
		}
		const edges: Edge[] = [];
		// Containment edges: every node hangs off its deepest shared
		// prefix — one parent per node, deduplicated by construction.
		for (const ns of nsIds) {
			const parent = nsParent(ns, nsIds);
			if (parent !== null) {
				edges.push({
					id: `h:${parent}->ns:${ns}`,
					source: parent,
					target: `ns:${ns}`,
					style: { ...TREE_EDGE_STYLE },
				});
			}
		}
		for (const m of members) {
			const parent = nsParent(m.id, nsIds);
			if (parent !== null) {
				edges.push({
					id: `h:${parent}->${m.id}`,
					source: parent,
					target: m.id,
					style: { ...TREE_EDGE_STYLE },
				});
			}
		}
		for (const l of liftedDepEdges(graph, nsIds, hidden)) {
			const style = { ...EDGE_STYLE[l.kind] };
			if (l.kind === "required" && !l.source.startsWith("ns:") && !enabledSet.has(l.source)) {
				style.stroke = "var(--destructive)";
			}
			edges.push({
				id: `${l.source}->${l.target}:${l.kind}`,
				source: l.source,
				target: l.target,
				label: l.count > 1 ? `×${l.count}` : undefined,
				style,
				markerEnd:
					l.kind === "required" ? { type: MarkerType.ArrowClosed, color: style.stroke } : undefined,
			});
		}
		return { nodes, edges };
	}

	if (view === "domains") {
		const lanes = new Map<string, GraphNode[]>();
		for (const node of graph.nodes.filter(isPluginNode).filter((n) => !hidden.has(n.id))) {
			const domain = domainOf(node);
			lanes.set(domain, [...(lanes.get(domain) ?? []), node]);
		}
		const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
		const laneWidth =
			LANE_PAD_X * 2 +
			Math.min(LANE_COLS, Math.max(1, ...[...lanes.values()].map((l) => l.length))) * LANE_COL_W;
		const nodes: MapFlowNode[] = [];
		let y = 0;
		for (const [domain, members] of lanes) {
			const laneH = LANE_HEADER_H + Math.ceil(members.length / LANE_COLS) * (LAYOUT_ROW_HEIGHT + 8);
			nodes.push({
				id: `lane:${domain}`,
				type: "lane",
				position: { x: 0, y },
				data: { label: domain },
				selectable: false,
				draggable: false,
				style: { width: laneWidth, height: laneH, zIndex: -1 },
			});
			members.forEach((node, i) => {
				nodes.push({
					id: node.id,
					type: "plugin",
					position: {
						x: LANE_PAD_X + (i % LANE_COLS) * LANE_COL_W,
						y: y + LANE_HEADER_H + Math.floor(i / LANE_COLS) * (LAYOUT_ROW_HEIGHT + 8),
					},
					data: pluginData(node),
				});
			});
			y += laneH + LANE_GAP;
		}
		// Cross-domain dep edges only — intra-domain coupling is the
		// part the view deliberately hides.
		const edges = graph.edges
			.filter((e) => {
				if (e.kind !== "required" && e.kind !== "optional") return false;
				if (hidden.has(e.source) || hidden.has(e.target)) return false;
				const s = nodeById.get(e.source);
				const t = nodeById.get(e.target);
				return s !== undefined && t !== undefined && domainOf(s) !== domainOf(t);
			})
			.map((e) => flowEdgeOf(e, enabledSet));
		return { nodes, edges };
	}

	const layout = layeredLayout(graph);
	const shownEdges = (
		view === "channels"
			? graph.edges.filter((e) => e.kind === "region" || e.kind === "kind")
			: graph.edges.filter((e) => e.kind === "required" || e.kind === "optional")
	).filter((e) => !hidden.has(e.source) && !hidden.has(e.target));
	const shownIds = new Set(shownEdges.flatMap((e) => [e.source, e.target]));
	const nodes: MapFlowNode[] = graph.nodes
		.filter((n) => (isPluginNode(n) || shownIds.has(n.id)) && !hidden.has(n.id))
		.map((node) => {
			// layeredLayout positions every graph node.
			const position = layout.positions.get(node.id)!;
			if (isPluginNode(node)) {
				return {
					id: node.id,
					type: "plugin",
					position,
					data: pluginData(node),
				};
			}
			return {
				id: node.id,
				type: "pseudo",
				position,
				data: { node },
			};
		});
	return { nodes, edges: shownEdges.map((e) => flowEdgeOf(e, enabledSet)) };
};

// ── ELK layout ─────────────────────────────────────────────────────
// elkjs is ~1.5MB bundled — lazy-imported so the map tab paints the
// manual layered layout instantly, then ELK snaps the topology into
// a proper layered arrangement.

/** Absolute box ELK assigns to a node; lanes also carry a size so the
 * swimlane div can be resized to fit its members. */
type ElkBox = { x: number; y: number; width?: number; height?: number };

/** Rendered-node size estimates fed to ELK (plugin card is w-56, the
 * pseudo chip w-48 — see the node views below). */
const NODE_SIZE = {
	plugin: { width: 224, height: 92 },
	pseudo: { width: 192, height: 56 },
	ns: { width: 176, height: 56 },
};

const ELK_LAYOUT_OPTIONS = {
	"elk.algorithm": "layered",
	// DOWN: the graph is wide (many plugins per layer, few layers) —
	// layers become rows so breadth spreads horizontally.
	"elk.direction": "DOWN",
	"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
	"elk.layered.spacing.nodeNodeBetweenLayers": "80",
	"elk.spacing.nodeNode": "48",
	"elk.edgeRouting": "ORTHOGONAL",
};

type ElkRunner = { layout: (graph: ElkNode) => Promise<ElkNode> };

let elkInstance: ElkRunner | null = null;
const getElk = async (): Promise<ElkRunner> => {
	elkInstance ??= new (await import("elkjs/lib/elk.bundled.js")).default();
	return elkInstance;
};

/**
 * Ask ELK (layered algorithm, top→down) for node boxes. Flat views
 * layout the whole visible subgraph at once; Domains layouts each
 * swimlane's members independently (intra-domain deps inform the
 * layering inside the lane even though those edges stay hidden).
 * Re-runs whenever `hidden` changes, so collapsing a branch makes
 * the remaining subgraph reorganize around what's left.
 */
export const elkPositions = async (
	graph: PluginGraph,
	view: MapView,
	hidden: ReadonlySet<string> = new Set(),
	collapsed: ReadonlySet<string> = new Set(),
): Promise<ReadonlyMap<string, ElkBox>> => {
	const elk = await getElk();
	const boxes = new Map<string, ElkBox>();
	const visible = (n: GraphNode): boolean => !hidden.has(n.id);
	const visibleEdge = (e: GraphEdge): boolean => !hidden.has(e.source) && !hidden.has(e.target);

	if (view === "hierarchy") {
		// Flat layout: virtual `ns:` parents are ordinary nodes — tree
		// edges pull each child under its prefix, lifted dep edges wire
		// ns↔ns as the single cross-namespace connection.
		const { members, nsIds } = hierarchyShape(graph, hidden, collapsed);
		const seen = new Set<string>();
		const elkEdges: { source: string; target: string }[] = [];
		const push = (source: string, target: string) => {
			const key = `${source}#${target}`;
			if (!seen.has(key)) {
				seen.add(key);
				elkEdges.push({ source, target });
			}
		};
		for (const ns of nsIds) {
			const parent = nsParent(ns, nsIds);
			if (parent !== null) push(parent, `ns:${ns}`);
		}
		for (const m of members) {
			const parent = nsParent(m.id, nsIds);
			if (parent !== null) push(parent, m.id);
		}
		for (const e of liftedDepEdges(graph, nsIds, hidden)) push(e.source, e.target);
		const laid = await elk.layout({
			id: "root",
			layoutOptions: ELK_LAYOUT_OPTIONS,
			children: [
				...[...nsIds].sort().map((ns): ElkNode => ({ id: `ns:${ns}`, ...NODE_SIZE.ns })),
				...members.map((m): ElkNode => ({ id: m.id, ...NODE_SIZE.plugin })),
			],
			edges: elkEdges.map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
		});
		// ELK always resolves children with x/y for a laid-out graph.
		for (const child of laid.children!) {
			boxes.set(child.id, { x: child.x!, y: child.y! });
		}
		return boxes;
	}

	if (view === "domains") {
		const lanes = new Map<string, GraphNode[]>();
		for (const node of graph.nodes.filter(isPluginNode).filter(visible)) {
			const domain = domainOf(node);
			lanes.set(domain, [...(lanes.get(domain) ?? []), node]);
		}
		// Lanes sit side by side so the map keeps growing horizontally;
		// each lane's inner layout is the same top→down layering.
		let x = 0;
		for (const [domain, members] of lanes) {
			const ids = new Set(members.map((m) => m.id));
			const intra = graph.edges.filter(
				(e) =>
					(e.kind === "required" || e.kind === "optional") &&
					ids.has(e.source) &&
					ids.has(e.target) &&
					visibleEdge(e),
			);
			const laid = await elk.layout({
				id: `lane:${domain}`,
				layoutOptions: ELK_LAYOUT_OPTIONS,
				children: members.map((m) => ({ id: m.id, ...NODE_SIZE.plugin })),
				edges: intra.map((e, i) => ({ id: `in${i}`, sources: [e.source], targets: [e.target] })),
			});
			const width = LANE_PAD_X * 2 + laid.width!;
			const height = LANE_HEADER_H + laid.height!;
			boxes.set(`lane:${domain}`, { x, y: 0, width, height });
			for (const child of laid.children!) {
				boxes.set(child.id, {
					x: x + LANE_PAD_X + child.x!,
					y: LANE_HEADER_H + child.y!,
				});
			}
			x += width + LANE_GAP;
		}
		return boxes;
	}

	const shownEdges = (
		view === "channels"
			? graph.edges.filter((e) => e.kind === "region" || e.kind === "kind")
			: graph.edges.filter((e) => e.kind === "required" || e.kind === "optional")
	).filter(visibleEdge);
	const shownIds = new Set(shownEdges.flatMap((e) => [e.source, e.target]));
	const laidNodes = graph.nodes.filter(
		(n) => (isPluginNode(n) || shownIds.has(n.id)) && visible(n),
	);
	const laid = await elk.layout({
		id: "root",
		layoutOptions: ELK_LAYOUT_OPTIONS,
		children: laidNodes.map((n): ElkNode => ({
			id: n.id,
			...(isPluginNode(n) ? NODE_SIZE.plugin : NODE_SIZE.pseudo),
		})),
		edges: shownEdges.map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
	});
	for (const child of laid.children!) {
		boxes.set(child.id, { x: child.x!, y: child.y! });
	}
	return boxes;
};

/** Card node for a real plugin: icon + name + status dot + domain badge. */
function PluginNodeView({ id, data, selected }: NodeProps<PluginFlowNode>) {
	const Icon = data.node.plugin?.meta?.icon;
	const dimmed = useDimmed(id);
	return (
		<Node
			handles={{ target: false, source: false }}
			className={cn(
				"w-56",
				dimmed && "opacity-25",
				selected && "ring-2 ring-ring",
				data.status === "disabled" && "border-dashed opacity-75",
				data.status === "blocked" && "border-destructive",
			)}
		>
			{/* ELK lays out top→down, so handles live on the vertical axis
			 * (the design-system Node hardcodes left/right). */}
			<Handle type="target" position={Position.Top} />
			<Handle type="source" position={Position.Bottom} />
			<NodeHeader className="flex-row items-center gap-2">
				{Icon !== undefined ? <Icon className="size-4 shrink-0" /> : null}
				<NodeTitle className="truncate text-xs">{data.displayName}</NodeTitle>
				<span
					className={cn("ml-auto size-2 shrink-0 rounded-full", STATUS_DOT[data.status])}
					title={data.status}
				/>
			</NodeHeader>
			<NodeContent className="py-2">
				<div className="truncate font-mono text-[10px] text-muted-foreground">{data.node.id}</div>
				{data.node.plugin?.meta?.keywords?.[0] !== undefined ? (
					<Badge variant="secondary" className="mt-1 text-[10px]">
						{data.node.plugin.meta.keywords[0]}
					</Badge>
				) : null}
			</NodeContent>
			{/* Branch collapse: hides the transitive dependent subgraph.
			 * stopPropagation keeps the click from opening the sheet. */}
			{data.branchCount > 0 ? (
				<button
					type="button"
					className="nodrag absolute -bottom-2.5 left-1/2 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center rounded-full border bg-card px-1 text-[10px] font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted"
					onClick={(e) => {
						e.stopPropagation();
						data.onToggleCollapse(data.node.id);
					}}
				>
					{data.collapsed ? `+${data.branchCount}` : <ChevronDownIcon className="size-3" />}
				</button>
			) : null}
		</Node>
	);
}

/** Pseudo-node: a chrome region slot or a host surface that consumes
 * contributions. Dashed border, no status. */
function PseudoNodeView({ id, data, selected }: NodeProps<PseudoFlowNode>) {
	const dimmed = useDimmed(id);
	return (
		<div
			className={cn(
				"w-48 rounded-md border border-dashed border-muted-foreground/50 bg-muted/40 px-3 py-2",
				dimmed && "opacity-25",
				selected && "ring-2 ring-ring",
			)}
		>
			<Handle type="target" position={Position.Top} />
			<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
				{data.node.pseudo === "region" ? "region" : "surface"}
			</div>
			<div className="truncate font-mono text-xs">{data.node.label}</div>
		</div>
	);
}

/** Swimlane backdrop for the Domains view — a bordered band behind
 * the domain's nodes, labeled with the domain keyword. */
function LaneView({ data }: NodeProps<LaneFlowNode>) {
	return (
		<div className="h-full w-full rounded-md border border-border/60 bg-muted/20">
			<div className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{data.label}
			</div>
		</div>
	);
}

/** Virtual namespace node: a compact hub card every member of the
 * shared prefix hangs off. Collapsible — folds the whole subtree
 * behind a "+N" count while external deps still terminate at it. */
function NsView({ id, data }: NodeProps<NsFlowNode>) {
	const dimmed = useDimmed(id);
	return (
		<div
			className={cn(
				"relative w-44 rounded-md border border-dashed border-muted-foreground/60 bg-muted/40 px-3 py-2",
				dimmed && "opacity-25",
			)}
		>
			<Handle type="target" position={Position.Top} />
			<Handle type="source" position={Position.Bottom} />
			<div className="flex items-center gap-1.5">
				<NetworkIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate font-mono text-xs font-medium">{data.label}</span>
				<span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
					{data.memberCount}
				</span>
			</div>
			<button
				type="button"
				className="nodrag absolute -bottom-2.5 left-1/2 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center rounded-full border bg-card px-1 text-[10px] font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted"
				onClick={(e) => {
					e.stopPropagation();
					data.onToggleCollapse(id);
				}}
			>
				{data.collapsed ? `+${data.memberCount}` : <ChevronDownIcon className="size-3" />}
			</button>
		</div>
	);
}

const nodeTypes = { plugin: PluginNodeView, pseudo: PseudoNodeView, lane: LaneView, ns: NsView };

export interface PluginsMapPageProps {
	readonly plugins: readonly Plugin[];
	/** Enabled-id set and missing-dep rows, precomputed by the page so
	 * the map and the table agree on status. */
	readonly enabledSet: ReadonlySet<string>;
	readonly missingById: ReadonlyMap<string, readonly string[]>;
	readonly busy: boolean;
	readonly t: ManagerMessages;
	readonly onToggle: (plugin: Plugin, enabled: boolean) => void;
	readonly onConfigure: (plugin: Plugin) => void;
}

/**
 * Interactive plugin-graph map (P-082): the registry rendered as a
 * React Flow canvas. Three views — Dependencies (dep edges by topo
 * layer), Channels (region/kind flow), Domains (keyword swimlanes with
 * cross-domain edges only). Nodes are interactive: hover highlights
 * the transitive neighborhood, click opens the manifest sheet.
 */
export function PluginsMapPage(props: PluginsMapPageProps) {
	return (
		<ReactFlowProvider>
			<MapCanvas {...props} />
		</ReactFlowProvider>
	);
}

function MapCanvas({
	plugins,
	enabledSet,
	missingById,
	busy,
	t,
	onToggle,
	onConfigure,
}: PluginsMapPageProps) {
	const rf = useReactFlow();
	// Screen state lives in the URL (nuqs → TanStack Router search
	// params): every control below is shareable/reload-safe.
	const [view, setView] = useQueryState(
		"view",
		parseAsStringLiteral(MAP_VIEWS).withDefault("dependencies"),
	);
	const [q, setQ] = useQueryState("q", parseAsString.withDefault(""));
	const [statusParam, setStatusParam] = useQueryState(
		"status",
		parseAsStringLiteral(STATUS_PARAMS),
	);
	const statusFilter: "all" | MapStatus = statusParam ?? "all";
	const [nodeId, setNodeId] = useQueryState("node", parseAsString);
	const [hiddenIds, setHiddenIds] = useQueryState(
		"hide",
		parseAsArrayOf(parseAsString).withDefault([]),
	);
	const [isFullscreen, setIsFullscreen] = useQueryState("fs", parseAsBoolean.withDefault(false));
	const [hovered, setHovered] = useState<string | null>(null);
	const collapsed = useMemo(() => new Set(hiddenIds), [hiddenIds]);

	const graph = useMemo(() => graphFromPlugins(plugins), [plugins]);
	const selected = useMemo(
		() => (nodeId === null ? null : (graph.nodes.find((n) => n.id === nodeId) ?? null)),
		[graph, nodeId],
	);

	const statusById = useMemo(() => {
		const map = new Map<string, MapStatus>();
		for (const node of graph.nodes) {
			if (node.plugin === undefined) continue;
			const status: MapStatus =
				node.plugin.system === true
					? "system"
					: (missingById.get(node.id) ?? []).length > 0
						? "blocked"
						: enabledSet.has(node.id)
							? "enabled"
							: "disabled";
			map.set(node.id, status);
		}
		return map;
	}, [graph, enabledSet, missingById]);

	// Nodes outside the focus neighborhood (or failing search/status)
	// dim instead of disappearing — the layout stays stable.
	const dimmedById = useMemo(() => {
		const map = new Map<string, boolean>();
		const focusId = hovered ?? selected?.id ?? null;
		const focus = focusId === null ? null : focusNeighborhood(graph, focusId);
		const needle = q.trim().toLowerCase();
		for (const node of graph.nodes) {
			let dim = false;
			if (focus !== null && node.id !== focusId) {
				dim = !focus.upstream.has(node.id) && !focus.downstream.has(node.id);
			}
			if (!dim && needle !== "" && node.plugin !== undefined) {
				const haystack = [
					node.id,
					node.plugin.meta?.name ?? "",
					node.plugin.meta?.description ?? "",
					(node.plugin.meta?.keywords ?? []).join(" "),
				]
					.join(" ")
					.toLowerCase();
				dim = !haystack.includes(needle);
			}
			if (!dim && statusFilter !== "all" && isPluginNode(node)) {
				dim = statusById.get(node.id) !== statusFilter;
			}
			map.set(node.id, dim);
		}
		// ns hubs aren't graph nodes — they dim only when every member
		// dims, so a lit member keeps its whole parent chain readable.
		for (const node of graph.nodes) {
			if (!isPluginNode(node)) continue;
			for (const ns of nsChain(node.id)) {
				const key = `ns:${ns}`;
				map.set(key, (map.get(key) ?? true) && map.get(node.id) === true);
			}
		}
		return map;
	}, [graph, hovered, selected, q, statusFilter, statusById]);

	// Branch collapse: a collapsed plugin hides its transitive
	// dep-dependents; a collapsed `ns:` hides only its own subtree
	// members (external deps still terminate at the folded hub).
	// A shared pseudo-node (region/surface) survives while at least
	// one visible plugin still points at it.
	const hiddenById = useMemo(() => {
		const hidden = new Set<string>();
		for (const id of collapsed) {
			if (id.startsWith("ns:")) {
				const prefix = `${id.slice(3)}.`;
				for (const n of graph.nodes) {
					if (isPluginNode(n) && n.id.startsWith(prefix)) hidden.add(n.id);
				}
				continue;
			}
			for (const d of focusNeighborhood(graph, id).downstream) hidden.add(d);
		}
		// Every downstream/ns-member id is a plugin, so `hidden` never
		// contains pseudo-nodes — no rescue pass needed.
		return hidden;
	}, [graph, collapsed]);

	const toggleCollapse = useCallback(
		(id: string) => {
			void setHiddenIds((prev) =>
				prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
			);
		},
		[setHiddenIds],
	);

	const { nodes, edges } = useMemo(
		() =>
			buildFlow(graph, view, statusById, enabledSet, {
				hidden: hiddenById,
				collapsed,
				onToggleCollapse: toggleCollapse,
			}),
		[graph, view, statusById, enabledSet, hiddenById, collapsed, toggleCollapse],
	);

	// ELK lays the graph out asynchronously — re-runs whenever the
	// shape changes (view switch, collapse/expand), so the remaining
	// subgraph reorganizes. The result is keyed on its inputs so a
	// stale resolution is simply ignored; nodes only paint once boxes
	// exist, which avoids the manual→ELK double-layout flicker.
	const [elkResult, setElkResult] = useState<{
		graph: PluginGraph;
		view: MapView;
		hidden: ReadonlySet<string>;
		boxes: ReadonlyMap<string, ElkBox>;
	} | null>(null);
	useEffect(() => {
		let alive = true;
		void elkPositions(graph, view, hiddenById, collapsed).then((boxes) => {
			if (alive) setElkResult({ graph, view, hidden: hiddenById, boxes });
		});
		return () => {
			alive = false;
		};
	}, [graph, view, hiddenById, collapsed]);
	// Boxes for the current view: while a relayout (e.g. after a
	// collapse) is pending, the last resolved boxes for THIS view keep
	// nodes in place — no jump back to manual positions.
	const elkBoxes =
		elkResult !== null && elkResult.graph === graph && elkResult.view === view
			? elkResult.boxes
			: null;
	// Fit once a fresh ELK layout for the current inputs has painted.
	useEffect(() => {
		if (elkBoxes === null || elkResult === null || elkResult.hidden !== hiddenById) return;
		const raf = requestAnimationFrame(() => void rf.fitView({ duration: 300, padding: 0.15 }));
		return () => cancelAnimationFrame(raf);
	}, [elkBoxes, elkResult, hiddenById, rf]);

	const renderNodes = useMemo(() => {
		if (elkBoxes === null) return nodes;
		return nodes.map((n): MapFlowNode => {
			const box = elkBoxes.get(n.id);
			if (box === undefined) return n;
			return {
				...n,
				position: { x: box.x, y: box.y },
				...(box.width !== undefined
					? { style: { ...n.style, width: box.width, height: box.height } }
					: {}),
			};
		});
	}, [nodes, elkBoxes]);

	// Expanded mode: the map covers the whole page via fixed
	// positioning — same result as the Fullscreen API, but works
	// inside iframes/previews where requestFullscreen is blocked.
	// Esc exits, like F11.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isFullscreen && e.key === "Escape") void setIsFullscreen(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [isFullscreen, setIsFullscreen]);
	const toggleFullscreen = () => void setIsFullscreen((v) => !v);
	// Refit after the container resize lands.
	useEffect(() => {
		const t = window.setTimeout(() => void rf.fitView({ duration: 200, padding: 0.1 }), 80);
		return () => window.clearTimeout(t);
	}, [isFullscreen, rf]);

	const focusNode = (id: string) =>
		void rf.fitView({ nodes: [{ id }], duration: 300, padding: 0.6 });

	const selectedPlugin = selected?.plugin;

	return (
		<div
			className={cn(
				"overflow-hidden border border-border bg-background",
				isFullscreen ? "fixed inset-0 z-50" : "relative h-[70vh] rounded-lg",
			)}
		>
			<DimContext.Provider value={dimmedById}>
				<Canvas
					nodes={elkBoxes === null ? [] : renderNodes}
					edges={edges}
					nodeTypes={nodeTypes}
					nodesDraggable={false}
					nodesConnectable={false}
					panOnDrag
					panOnScroll={false}
					minZoom={0.2}
					onNodeClick={(_, node) => {
						if (node.type === "plugin" || node.type === "pseudo") void setNodeId(node.id);
						else void setNodeId(null);
					}}
					onNodeMouseEnter={(_, node) => {
						// ns/lane containers aren't graph nodes — hovering them
						// would compute an empty neighborhood and dim the map.
						if (node.type === "plugin" || node.type === "pseudo") setHovered(node.id);
					}}
					onNodeMouseLeave={() => setHovered(null)}
					onPaneClick={() => void setNodeId(null)}
				>
					<Panel
						position="top-left"
						className="flex items-center gap-2 rounded-md border bg-card p-2"
					>
						<ToggleGroup
							value={[view]}
							onValueChange={(values) => {
								const next = values[values.length - 1] as MapView | undefined;
								if (next) void setView(next);
							}}
							size="sm"
						>
							<ToggleGroupItem value="dependencies" aria-label={t.viewDependencies}>
								<WaypointsIcon className="size-3.5" />
								{t.viewDependencies}
							</ToggleGroupItem>
							<ToggleGroupItem value="channels" aria-label={t.viewChannels}>
								<LayersIcon className="size-3.5" />
								{t.viewChannels}
							</ToggleGroupItem>
							<ToggleGroupItem value="domains" aria-label={t.viewDomains}>
								<LayoutGridIcon className="size-3.5" />
								{t.viewDomains}
							</ToggleGroupItem>
							<ToggleGroupItem value="hierarchy" aria-label={t.viewHierarchy}>
								<NetworkIcon className="size-3.5" />
								{t.viewHierarchy}
							</ToggleGroupItem>
						</ToggleGroup>
						<Input
							type="search"
							value={q}
							onChange={(e) => void setQ(e.target.value)}
							placeholder={t.searchPlaceholder}
							aria-label={t.searchLabel}
							className="w-48"
						/>
						<Select
							items={[
								{ value: "all", label: t.filterAll },
								{ value: "enabled", label: t.statusEnabled },
								{ value: "disabled", label: t.statusDisabled },
								{ value: "blocked", label: t.statusBlocked },
							]}
							value={statusFilter}
							onValueChange={(v) => {
								const next = String(v) as "all" | MapStatus;
								void setStatusParam(next === "all" ? null : next);
							}}
						>
							<SelectTrigger size="sm" aria-label={t.statusFilterLabel} className="w-32">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">{t.filterAll}</SelectItem>
								<SelectItem value="enabled">{t.statusEnabled}</SelectItem>
								<SelectItem value="disabled">{t.statusDisabled}</SelectItem>
								<SelectItem value="blocked">{t.statusBlocked}</SelectItem>
							</SelectContent>
						</Select>
						<Button
							variant="outline"
							size="icon-sm"
							onClick={toggleFullscreen}
							aria-label={isFullscreen ? t.fullscreenExit : t.fullscreenEnter}
							title={isFullscreen ? t.fullscreenExit : t.fullscreenEnter}
						>
							{isFullscreen ? (
								<Minimize2Icon className="size-3.5" />
							) : (
								<Maximize2Icon className="size-3.5" />
							)}
						</Button>
					</Panel>
					<Panel
						position="bottom-left"
						className="rounded-md border bg-card p-2 text-[10px] text-muted-foreground"
					>
						<div className="flex flex-col gap-1">
							<Legend swatch={{ background: "var(--primary)" }} label={t.edgeRequired} />
							<Legend
								swatch={{ borderTop: "1px dashed var(--muted-foreground)" }}
								label={t.edgeOptional}
							/>
							<Legend swatch={{ borderTop: "1px dashed var(--chart-2)" }} label={t.edgeRegion} />
							<Legend
								swatch={{ borderTop: "1px dotted var(--muted-foreground)" }}
								label={t.edgeKind}
							/>
							<Legend
								swatch={{ borderTop: "1px solid var(--muted-foreground)" }}
								label={t.edgeTree}
							/>
						</div>
					</Panel>
					<Controls position="bottom-right" />
					<MiniMap
						position="top-right"
						pannable
						zoomable
						nodeColor={(n) => (n.type === "plugin" ? "var(--primary)" : "var(--border)")}
					/>
				</Canvas>
			</DimContext.Provider>
			{/* Layout gate: nodes only paint once ELK has boxes, so the
			 * first render and every view switch show a spinner instead
			 * of a manual→ELK double-layout flicker. */}
			{elkBoxes === null ? (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
					<Spinner className="size-4" />
					{t.layoutLoading}
				</div>
			) : null}

			<Sheet
				open={selectedPlugin !== undefined}
				// No SheetTrigger exists — the only transition is a close
				// request, which clears the deep-linked node param.
				onOpenChange={() => void setNodeId(null)}
			>
				<SheetContent side="right" className="w-96 overflow-y-auto">
					{selected?.plugin !== undefined ? (
						<ManifestSheet
							node={selected}
							graph={graph}
							status={statusById.get(selected.id)!}
							busy={busy}
							t={t}
							onToggle={onToggle}
							onConfigure={onConfigure}
							onFocusNode={focusNode}
						/>
					) : null}
				</SheetContent>
			</Sheet>
		</div>
	);
}

function Legend({ swatch, label }: { swatch: Record<string, string>; label: string }) {
	return (
		<div className="flex items-center gap-2">
			<span className="inline-block h-3 w-6 rounded-sm" style={swatch} />
			{label}
		</div>
	);
}

/** The manifest sheet — everything the plugin declares plus runtime
 * state and the same enable/configure actions the table row runs. */
export function ManifestSheet({
	node,
	graph,
	status,
	busy,
	t,
	onToggle,
	onConfigure,
	onFocusNode,
}: {
	node: GraphNode;
	graph: PluginGraph;
	status: MapStatus;
	busy: boolean;
	t: ManagerMessages;
	onToggle: (plugin: Plugin, enabled: boolean) => void;
	onConfigure: (plugin: Plugin) => void;
	onFocusNode: (id: string) => void;
}) {
	// Callers only mount the sheet for plugin nodes (selectedPlugin is
	// the selected node's plugin), so `plugin` is always defined here.
	const plugin = node.plugin!;
	const name = pluginDisplayName(plugin);
	const keywords = plugin.meta?.keywords ?? [];
	const dependents = graph.edges
		.filter((e) => e.source === node.id && (e.kind === "required" || e.kind === "optional"))
		.map((e) => e.target);
	const channels = graph.edges.filter(
		(e) => e.source === node.id && (e.kind === "region" || e.kind === "kind"),
	);
	return (
		<>
			<SheetHeader>
				<SheetTitle className="flex items-center gap-2">
					{plugin.meta?.icon !== undefined ? <plugin.meta.icon className="size-4" /> : null}
					{name}
				</SheetTitle>
				<SheetDescription>
					<span className="font-mono">{plugin.id}</span>
					{plugin.meta?.description ? ` — ${plugin.meta.description}` : ""}
				</SheetDescription>
			</SheetHeader>
			<div className="mt-4 space-y-5 px-4 pb-6">
				<section className="space-y-2">
					<div className="flex items-center gap-2">
						<Switch
							checked={status === "enabled" || status === "system"}
							disabled={plugin.system === true || busy}
							onCheckedChange={(next) => onToggle(plugin, next)}
							aria-label={name}
						/>
						<Badge variant={status === "enabled" || status === "system" ? "default" : "secondary"}>
							{status === "system"
								? t.statusSystem
								: status === "enabled"
									? t.statusEnabled
									: status === "blocked"
										? t.statusBlocked
										: t.statusDisabled}
						</Badge>
						{plugin.meta?.config !== undefined ? (
							<Button size="sm" variant="outline" onClick={() => onConfigure(plugin)}>
								{t.actionConfigure}
							</Button>
						) : null}
					</div>
					{plugin.system === true ? (
						<p className="text-xs text-muted-foreground">{t.systemHint}</p>
					) : null}
				</section>

				{keywords.length > 0 ? (
					<section>
						<h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{t.keywordsLabel}</h4>
						<div className="flex flex-wrap gap-1">
							{keywords.map((k) => (
								<Badge key={k} variant="secondary">
									{k}
								</Badge>
							))}
						</div>
					</section>
				) : null}

				<section>
					<h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{t.depsSection}</h4>
					<DepList
						title={t.edgeRequired}
						ids={plugin.requiredDeps ?? []}
						graph={graph}
						onFocusNode={onFocusNode}
					/>
					<DepList
						title={t.edgeOptional}
						ids={plugin.optionalDeps ?? []}
						graph={graph}
						onFocusNode={onFocusNode}
					/>
					<DepList
						title={t.dependentsSection}
						ids={dependents}
						graph={graph}
						onFocusNode={onFocusNode}
					/>
				</section>

				{channels.length > 0 ? (
					<section>
						<h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{t.regionsSection}</h4>
						<div className="flex flex-col gap-1">
							{channels.map((e) => (
								<button
									key={`${e.kind}:${e.target}`}
									type="button"
									className="flex items-center justify-between rounded-md border px-2 py-1 text-left text-xs hover:bg-muted"
									onClick={() => onFocusNode(e.target)}
								>
									<span className="font-mono">{e.label}</span>
									<span className="text-muted-foreground">→ {e.target}</span>
								</button>
							))}
						</div>
					</section>
				) : null}
			</div>
		</>
	);
}

function DepList({
	title,
	ids,
	graph,
	onFocusNode,
}: {
	title: string;
	ids: readonly string[];
	graph: PluginGraph;
	onFocusNode: (id: string) => void;
}) {
	if (ids.length === 0) return null;
	return (
		<div className="mb-2">
			<div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
			<div className="flex flex-wrap gap-1">
				{ids.map((id) => {
					const exists = graph.nodes.some((n) => n.id === id);
					return (
						<Badge
							key={id}
							variant="outline"
							className={cn(exists && "cursor-pointer hover:bg-muted")}
							render={exists ? <button type="button" onClick={() => onFocusNode(id)} /> : undefined}
						>
							{id}
						</Badge>
					);
				})}
			</div>
		</div>
	);
}
