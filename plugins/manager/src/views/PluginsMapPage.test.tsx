// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { definePlugin, type Plugin, type PluginId } from "@ktb/kernel";
import { createElement, type ComponentType, type ReactNode } from "react";

// React Flow needs ResizeObserver/DOMMatrix APIs jsdom lacks — the
// canvas is mocked to a plain listing that still exercises nodeTypes,
// click → manifest sheet, and the toolbar. Graph correctness itself is
// covered by logic.test.ts and buildFlow's pure outputs.
const fitView = vi.hoisted(() => vi.fn());

vi.mock("@xyflow/react", () => ({
	ReactFlow: ({
		nodes,
		nodeTypes,
		onNodeClick,
		children,
	}: {
		nodes: { id: string; type: string; data: unknown }[];
		nodeTypes: Record<string, ComponentType<{ id: string; data: unknown; selected: boolean }>>;
		onNodeClick?: (e: unknown, node: { id: string }) => void;
		children?: ReactNode;
	}) => (
		<div data-testid="canvas">
			{nodes.map((n) => (
				<button
					key={n.id}
					type="button"
					data-testid={`node-${n.id}`}
					onClick={(e) => onNodeClick?.(e, n)}
				>
					{createElement(nodeTypes[n.type], { id: n.id, data: n.data, selected: false })}
				</button>
			))}
			{children}
		</div>
	),
	Background: () => null,
	Handle: () => null,
	MiniMap: () => null,
	Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	Controls: () => null,
	ReactFlowProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
	useReactFlow: () => ({ fitView }),
	Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
	MarkerType: { ArrowClosed: "arrowclosed" },
}));

import { NuqsTestingAdapter, type OnUrlUpdateFunction } from "nuqs/adapters/testing";

import { PluginsMapPage, buildFlow, elkPositions, type MapStatus } from "./PluginsMapPage.tsx";
import { graphFromPlugins } from "../logic.ts";
import { managerMessages } from "../i18n.ts";

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"m.base": true;
		"m.child": true;
		"m.pub": true;
		"x.pub": true;
		"x.deep": true;
		"y.solo": true;
	}
}

const t = managerMessages("en");

const plugins: readonly Plugin[] = [
	definePlugin({
		id: "m.base",
		meta: { keywords: ["platform", "services"] },
	}),
	definePlugin({
		id: "m.child",
		requiredDeps: ["m.base"] as unknown as readonly PluginId[],
		meta: { name: "Child", keywords: ["platform", "ui"] },
	}),
	definePlugin({
		id: "m.pub",
		meta: { keywords: ["site", "ui"] },
		chrome: [
			{
				id: "m.pub.item",
				region: "portal.sidebar",
				content: { kind: "sidebarItem", item: { to: "/x", label: "X" } },
			},
		],
	}),
	// Second namespace: dep on both m.* siblings exercises the
	// ns-hub edge aggregation in the hierarchy view.
	definePlugin({
		id: "x.pub",
		requiredDeps: ["m.base", "m.child"] as unknown as readonly PluginId[],
		meta: { keywords: ["eval", "services"] },
	}),
	definePlugin({ id: "x.deep", meta: { keywords: ["eval", "ui"] } }),
	// Lone member of its prefix — must NOT produce a virtual ns node.
	definePlugin({ id: "y.solo", meta: { keywords: ["platform", "services"] } }),
];

const renderMap = (
	nuqs: {
		searchParams?: string;
		onUrlUpdate?: OnUrlUpdateFunction;
	} = {},
) =>
	render(
		<NuqsTestingAdapter hasMemory searchParams={nuqs.searchParams} onUrlUpdate={nuqs.onUrlUpdate}>
			<PluginsMapPage
				plugins={plugins}
				enabledSet={new Set(plugins.map((p) => p.id))}
				missingById={new Map()}
				busy={false}
				t={t}
				onToggle={() => {}}
				onConfigure={() => {}}
			/>
		</NuqsTestingAdapter>,
	);

describe("PluginsMapPage", () => {
	afterEach(cleanup);

	it("renders every registry plugin exactly once", async () => {
		renderMap();
		// Nodes paint after the async ELK layout resolves.
		for (const p of plugins) {
			expect(await screen.findByTestId(`node-${p.id}`)).toBeTruthy();
		}
	});

	it("opens the manifest sheet on node click with keywords and deps", async () => {
		renderMap();
		fireEvent.click(await screen.findByTestId("node-m.child"));
		// Sheet title plus node card both render the display name.
		expect(screen.getAllByText("Child").length).toBeGreaterThan(1);
		expect(screen.getByText(t.keywordsLabel)).toBeTruthy();
		// "Required dep" shows in both the legend and the sheet's dep list.
		expect(screen.getAllByText(t.edgeRequired).length).toBeGreaterThan(0);
		// The required dep chip focuses the dep node.
		const depChips = screen.getAllByText("m.base");
		fireEvent.click(depChips[depChips.length - 1]);
		expect(fitView).toHaveBeenCalledWith({
			nodes: [{ id: "m.base" }],
			duration: 300,
			padding: 0.6,
		});
	});

	it("switches views via the toggle group", async () => {
		renderMap();
		fireEvent.click(screen.getByLabelText(t.viewChannels));
		// Channels draws the region pseudo-node for portal.sidebar
		// (after its own ELK pass resolves).
		expect(await screen.findByTestId("node-region:portal.sidebar")).toBeTruthy();
	});

	it("writes state to the URL: view switch, node select, collapse", async () => {
		const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
		renderMap({ onUrlUpdate });
		const lastSearch = () => onUrlUpdate.mock.calls.at(-1)?.[0].searchParams;
		fireEvent.click(screen.getByLabelText(t.viewHierarchy));
		await vi.waitFor(() => expect(lastSearch()?.get("view")).toBe("hierarchy"));
		expect(await screen.findByTestId("node-ns:m")).toBeTruthy();
		// Selecting a node deep-links its manifest sheet.
		fireEvent.click(await screen.findByTestId("node-m.child"));
		await vi.waitFor(() => expect(lastSearch()?.get("node")).toBe("m.child"));
	});

	it("restores state from the URL: view + collapsed branch", async () => {
		renderMap({ searchParams: "?view=hierarchy&hide=ns:m" });
		// The folded namespace renders as its virtual "+N" node…
		expect(await screen.findByTestId("node-ns:m")).toBeTruthy();
		// …while its members stay out of the canvas.
		expect(screen.queryByTestId("node-m.base")).toBeNull();
		expect(screen.queryByTestId("node-m.child")).toBeNull();
		// Sibling namespaces and outside members are untouched.
		expect(await screen.findByTestId("node-ns:x")).toBeTruthy();
		expect(await screen.findByTestId("node-x.pub")).toBeTruthy();
	});
});

describe("buildFlow", () => {
	const graph = graphFromPlugins(plugins);
	const allEnabled = new Set(plugins.map((p) => p.id));
	const noStatus = new Map<string, MapStatus>();

	it("dependencies view: dep edges only, no pseudo-nodes", () => {
		const { nodes, edges } = buildFlow(graph, "dependencies", noStatus, allEnabled);
		expect(nodes.every((n) => n.type === "plugin")).toBe(true);
		expect(edges).toHaveLength(3);
		expect(edges[0].source).toBe("m.base");
		expect(edges[0].target).toBe("m.child");
	});

	it("channels view: region/kind edges + pseudo-nodes only", () => {
		const { nodes, edges } = buildFlow(graph, "channels", noStatus, allEnabled);
		expect(edges.every((e) => e.label !== undefined)).toBe(true);
		expect(nodes.some((n) => n.type === "pseudo")).toBe(true);
		// No dep edges drawn.
		expect(edges.some((e) => e.id.includes(":required:"))).toBe(false);
	});

	it("domains view: lanes + cross-domain edges only", () => {
		const { nodes, edges } = buildFlow(graph, "domains", noStatus, allEnabled);
		const laneIds = nodes.filter((n) => n.type === "lane").map((n) => n.id);
		expect(laneIds.sort()).toEqual(["lane:eval", "lane:platform", "lane:site"]);
		// m.base→m.child is intra-domain (platform→platform) → hidden;
		// the two platform→eval dep edges show.
		expect(edges).toHaveLength(2);
	});

	it("tints required edges from disabled deps destructive", () => {
		const { edges } = buildFlow(graph, "dependencies", noStatus, new Set(["m.child"]));
		expect(edges[0].style?.stroke).toBe("var(--destructive)");
	});

	it("hierarchy view: one virtual ns node per shared prefix", () => {
		const { nodes } = buildFlow(graph, "hierarchy", noStatus, allEnabled);
		for (const ns of ["ns:m", "ns:x"]) {
			expect(nodes.some((n) => n.id === ns && n.type === "ns")).toBe(true);
		}
		// Single-member prefixes ("y" → only y.solo) get no node.
		expect(nodes.some((n) => n.id === "ns:y")).toBe(false);
	});

	it("hierarchy view: tree edges give every node a single parent", () => {
		const { edges } = buildFlow(graph, "hierarchy", noStatus, allEnabled);
		const tree = edges.filter((e) => e.id.startsWith("h:"));
		for (const [parent, child] of [
			["ns:m", "m.base"],
			["ns:m", "m.child"],
			["ns:m", "m.pub"],
			["ns:x", "x.pub"],
			["ns:x", "x.deep"],
		] as const) {
			expect(
				tree.filter((e) => e.source === parent && e.target === child),
				`${parent}→${child}`,
			).toHaveLength(1);
		}
		// y.solo's prefix is unshared → root-level, no tree edge in.
		expect(tree.some((e) => e.target === "y.solo")).toBe(false);
	});

	it("hierarchy view: cross-namespace deps lift to a single ns→ns hub", () => {
		const { edges } = buildFlow(graph, "hierarchy", noStatus, allEnabled);
		// Intra-ns dep stays member-level under ns:m…
		expect(edges.some((e) => e.source === "m.base" && e.target === "m.child")).toBe(true);
		// …while both m.*→x.pub deps collapse into ONE ns:m→ns:x
		// connection carrying the count — one parent, one source,
		// one connection.
		const hub = edges.filter((e) => e.source === "ns:m" && e.target === "ns:x");
		expect(hub).toHaveLength(1);
		expect(hub[0].label).toBe("×2");
	});

	it("hierarchy view: a folded ns keeps its hub node and outbound edge", () => {
		const hidden = new Set(["m.base", "m.child", "m.pub"]);
		const collapsed = new Set(["ns:m"]);
		const { nodes, edges } = buildFlow(graph, "hierarchy", noStatus, allEnabled, {
			hidden,
			collapsed,
		});
		const ns = nodes.find((n) => n.id === "ns:m");
		expect(ns?.type).toBe("ns");
		// Folded renders "+memberCount" and stays connected: the
		// m.*→x.pub deps still land on the hub, not the members.
		expect((ns?.data as { memberCount: number }).memberCount).toBe(3);
		expect((ns?.data as { collapsed: boolean }).collapsed).toBe(true);
		expect(edges.some((e) => e.source === "ns:m" && e.target === "ns:x")).toBe(true);
		expect(edges.some((e) => e.source === "m.base")).toBe(false);
	});
});

describe("elkPositions", () => {
	const graph = graphFromPlugins(plugins);

	it("positions every visible node (dependencies)", async () => {
		const boxes = await elkPositions(graph, "dependencies");
		expect(boxes.size).toBe(graph.nodes.filter((n) => n.plugin !== undefined).length);
		// ELK layers top→down: the dep sits above the dependent.
		expect(boxes.get("m.base")!.y).toBeLessThan(boxes.get("m.child")!.y);
	});

	it("positions every visible node incl. pseudo-nodes (channels)", async () => {
		const boxes = await elkPositions(graph, "channels");
		expect(boxes.has("m.pub")).toBe(true);
		expect(boxes.has("region:portal.sidebar")).toBe(true);
	});

	it("emits lane boxes sized to their members (domains)", async () => {
		const boxes = await elkPositions(graph, "domains");
		const lane = boxes.get("lane:platform")!;
		expect(lane.width!).toBeGreaterThan(0);
		expect(lane.height!).toBeGreaterThan(0);
		// Lanes sit side by side; members sit inside their lane's box.
		const member = boxes.get("m.base")!;
		expect(member.x).toBeGreaterThanOrEqual(lane.x);
		expect(member.x).toBeLessThanOrEqual(lane.x + lane.width!);
	});

	it("honors the hidden set: collapsed branches re-layout", async () => {
		const hidden = new Set(["m.child"]);
		const boxes = await elkPositions(graph, "dependencies", hidden);
		expect(boxes.has("m.child")).toBe(false);
		expect(boxes.has("m.base")).toBe(true);
	});

	it("emits flat boxes for virtual ns nodes and members (hierarchy)", async () => {
		const boxes = await elkPositions(graph, "hierarchy");
		for (const id of ["ns:m", "ns:x", "m.base", "m.child", "x.pub", "x.deep", "y.solo"]) {
			const box = boxes.get(id);
			expect(box, id).toBeDefined();
			expect(Number.isFinite(box!.x) && Number.isFinite(box!.y)).toBe(true);
		}
		// No virtual node for the lone-member prefix.
		expect(boxes.has("ns:y")).toBe(false);
	});

	it("hierarchy layout keeps the folded ns hub when collapsed", async () => {
		const boxes = await elkPositions(
			graph,
			"hierarchy",
			new Set(["m.base", "m.child", "m.pub"]),
			new Set(["ns:m"]),
		);
		expect(boxes.has("ns:m")).toBe(true);
		expect(boxes.has("m.base")).toBe(false);
		expect(boxes.has("ns:x")).toBe(true);
	});
});
