// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { definePlugin, type Plugin, type PluginId } from "@ktb/kernel";
import { Schema } from "effect";
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
		onNodeMouseEnter,
		onNodeMouseLeave,
		onPaneClick,
		children,
	}: {
		nodes: { id: string; type: string; data: unknown }[];
		nodeTypes: Record<string, ComponentType<{ id: string; data: unknown; selected: boolean }>>;
		onNodeClick?: (e: unknown, node: { id: string; type: string }) => void;
		onNodeMouseEnter?: (e: unknown, node: { id: string; type: string }) => void;
		onNodeMouseLeave?: (e: unknown, node: { id: string; type: string }) => void;
		onPaneClick?: (e: unknown) => void;
		children?: ReactNode;
	}) => (
		<div data-testid="canvas">
			{nodes.map((n) => (
				<button
					key={n.id}
					type="button"
					data-testid={`node-${n.id}`}
					onClick={(e) => onNodeClick?.(e, n)}
					onMouseEnter={() => onNodeMouseEnter?.(null, n)}
					onMouseLeave={() => onNodeMouseLeave?.(null, n)}
				>
					{createElement(nodeTypes[n.type], {
						id: n.id,
						data: n.data,
						// Mark one node of each family selected so the
						// selection-ring branch renders.
						selected:
							n.id === "m.pub" || n.id === "region:portal.sidebar" || n.id === "surface:eval-cli",
					})}
				</button>
			))}
			<div data-testid="pane" onClick={() => onPaneClick?.(null)} />
			{children}
		</div>
	),
	Background: () => null,
	Handle: () => null,
	MiniMap: (props: { nodeColor?: (n: { type?: string }) => string }) => {
		// Exercise the color mapper for both node families.
		props.nodeColor?.({ type: "plugin" });
		props.nodeColor?.({ type: "pseudo" });
		return null;
	},
	Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	Controls: () => null,
	ReactFlowProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
	useReactFlow: () => ({ fitView }),
	Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
	MarkerType: { ArrowClosed: "arrowclosed" },
}));

import { NuqsTestingAdapter, type OnUrlUpdateFunction } from "nuqs/adapters/testing";
import { Sheet } from "@ktbhealth/ui/components/sheet";

import {
	PluginsMapPage,
	ManifestSheet,
	buildFlow,
	elkPositions,
	type MapStatus,
} from "./PluginsMapPage.tsx";
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
		"n.one.a": true;
		"n.one.b": true;
		"n.two": true;
		"k.plain": true;
		"z.a": true;
		"z.b": true;
		"s.on": true;
		"s.off": true;
		"s.blocked": true;
		"s.sys": true;
		"s.ghost": true;
	}
}

const t = managerMessages("en");

const configSchemaDocument = Schema.toJsonSchemaDocument(Schema.Struct({}));

const FixtureIcon = ({ className }: { className?: string }) => (
	<svg className={className} data-testid="fixture-icon" />
);

const plugins: readonly Plugin[] = [
	definePlugin({
		id: "m.base",
		meta: { keywords: ["platform", "services"] },
	}),
	definePlugin({
		id: "m.child",
		requiredDeps: ["m.base"] as unknown as readonly PluginId[],
		// Optional edge on the same pair — ELK's edge dedup must merge
		// the required+optional lifts into one connection.
		optionalDeps: ["m.base"] as unknown as readonly PluginId[],
		meta: { name: "Child", keywords: ["platform", "ui"] },
	}),
	definePlugin({
		id: "m.pub",
		meta: {
			keywords: ["site", "ui"],
			config: { schema: configSchemaDocument },
			icon: FixtureIcon,
			description: "Pub plugin",
		},
		chrome: [
			{
				id: "m.pub.item",
				region: "portal.sidebar",
				content: { kind: "sidebarItem", item: { to: "/x", label: "X" } },
			},
		],
		// A generic contribution draws a `surface:` pseudo-node in the
		// channels view (kind edges land on host surfaces).
		contributions: [{ kind: "eval.stage", id: "s1", version: "1" }],
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
	// No meta at all — exercises the keyword/description/icon fallbacks.
	definePlugin({ id: "k.plain" }),
];

// Nested shared prefixes ("n" ⊃ "n.one") exercise the ns→ns
// containment edge that single-level fixtures can't produce. The
// n.two→n.one.a dep lifts onto the same ns:n→ns:n.one pair, so ELK
// sees a duplicate edge the dedup set must swallow.
const nestedPlugins: readonly Plugin[] = [
	definePlugin({
		id: "n.one.a",
		requiredDeps: ["n.two"] as unknown as readonly PluginId[],
	}),
	definePlugin({ id: "n.one.b" }),
	definePlugin({ id: "n.two" }),
];

const renderMap = (
	nuqs: {
		searchParams?: string;
		onUrlUpdate?: OnUrlUpdateFunction;
	} = {},
	props: Partial<Parameters<typeof PluginsMapPage>[0]> = {},
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
				{...props}
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

	it("collapses a plugin branch from the node badge and expands it again", async () => {
		const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
		renderMap({ onUrlUpdate });
		await screen.findByTestId("node-m.base");
		const lastSearch = () => onUrlUpdate.mock.calls.at(-1)?.[0].searchParams;
		const collapseButton = () =>
			screen.getByTestId("node-m.base").querySelector("button.nodrag") as HTMLElement;
		fireEvent.click(collapseButton());
		await vi.waitFor(() => expect(lastSearch()?.get("hide")).toContain("m.base"));
		// Downstream dependents leave the canvas; the branch stays as "+N".
		expect(await screen.findByTestId("node-m.base")).toBeTruthy();
		expect(screen.queryByTestId("node-m.child")).toBeNull();
		fireEvent.click(collapseButton());
		await vi.waitFor(() => expect(lastSearch()?.get("hide")).toBeNull());
		expect(await screen.findByTestId("node-m.child")).toBeTruthy();
	});

	it("collapses a namespace from its virtual node badge in hierarchy view", async () => {
		const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
		renderMap({ searchParams: "?view=hierarchy", onUrlUpdate });
		const lastSearch = () => onUrlUpdate.mock.calls.at(-1)?.[0].searchParams;
		const nsNode = await screen.findByTestId("node-ns:m");
		const collapseButton = nsNode.querySelector("button.nodrag") as HTMLElement;
		expect(collapseButton).toBeTruthy();
		fireEvent.click(collapseButton);
		await vi.waitFor(() => expect(lastSearch()?.get("hide")).toBe("ns:m"));
		expect(screen.queryByTestId("node-m.base")).toBeNull();
		expect(await screen.findByTestId("node-ns:x")).toBeTruthy();
		// Hovering a virtual node is a no-op for the focus dimmer.
		fireEvent.mouseEnter(screen.getByTestId("node-ns:x"));
		fireEvent.mouseLeave(screen.getByTestId("node-ns:x"));
	});

	it("domains view groups plugins into domain lanes", async () => {
		renderMap();
		fireEvent.click(screen.getByLabelText(t.viewDomains));
		expect(await screen.findByTestId("node-lane:platform")).toBeTruthy();
		expect(await screen.findByTestId("node-lane:site")).toBeTruthy();
		expect(await screen.findByTestId("node-lane:eval")).toBeTruthy();
	});

	it("dims non-matching plugins while the search box has a needle", async () => {
		renderMap();
		await screen.findByTestId("node-m.base");
		fireEvent.change(screen.getByLabelText(t.searchLabel), { target: { value: "eval" } });
		// eval-keyworded plugins stay lit; the rest dim.
		expect(screen.getByTestId("node-x.pub").querySelector(".opacity-25")).toBeNull();
		expect(screen.getByTestId("node-m.base").querySelector(".opacity-25")).toBeTruthy();
		fireEvent.change(screen.getByLabelText(t.searchLabel), { target: { value: "" } });
		await vi.waitFor(() =>
			expect(screen.getByTestId("node-m.base").querySelector(".opacity-25")).toBeNull(),
		);
	});

	it("filters by status via the select and restores All", async () => {
		const user = userEvent.setup();
		const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
		renderMap({ onUrlUpdate });
		const lastSearch = () => onUrlUpdate.mock.calls.at(-1)?.[0].searchParams;
		await user.click(screen.getByRole("combobox", { name: t.statusFilterLabel }));
		await user.click(await screen.findByRole("option", { name: t.statusDisabled }));
		await vi.waitFor(() => expect(lastSearch()?.get("status")).toBe("disabled"));
		// Every plugin is enabled → the whole set dims.
		expect((await screen.findByTestId("node-m.base")).querySelector(".opacity-25")).toBeTruthy();
		await user.click(screen.getByRole("combobox", { name: t.statusFilterLabel }));
		await user.click(await screen.findByRole("option", { name: t.filterAll }));
		await vi.waitFor(() => expect(lastSearch()?.get("status")).toBeNull());
		expect((await screen.findByTestId("node-m.base")).querySelector(".opacity-25")).toBeNull();
	});

	it("dims the unfocused neighborhood on hover and clears on leave", async () => {
		renderMap();
		const child = await screen.findByTestId("node-m.child");
		fireEvent.mouseEnter(child);
		// Neighbors of m.child (m.base upstream, x.pub downstream) stay
		// lit; unrelated plugins dim.
		expect(screen.getByTestId("node-m.base").querySelector(".opacity-25")).toBeNull();
		expect(screen.getByTestId("node-m.pub").querySelector(".opacity-25")).toBeTruthy();
		fireEvent.mouseLeave(child);
		await vi.waitFor(() =>
			expect(screen.getByTestId("node-m.pub").querySelector(".opacity-25")).toBeNull(),
		);
	});

	it("clears the selected node on pane click and on virtual-node click", async () => {
		const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
		renderMap({ searchParams: "?view=hierarchy", onUrlUpdate });
		const lastSearch = () => onUrlUpdate.mock.calls.at(-1)?.[0].searchParams;
		// Virtual ns nodes carry no manifest — clicking one clears state.
		fireEvent.click(await screen.findByTestId("node-ns:m"));
		await vi.waitFor(() => expect(lastSearch()?.get("node")).toBeNull());
		// Clicking empty canvas also clears a stale selection.
		fireEvent.click(await screen.findByTestId("node-m.child"));
		await vi.waitFor(() => expect(lastSearch()?.get("node")).toBe("m.child"));
		fireEvent.click(screen.getByTestId("pane"));
		await vi.waitFor(() => expect(lastSearch()?.get("node")).toBeNull());
	});

	it("toggles fullscreen and exits on Escape", async () => {
		renderMap();
		const enter = await screen.findByLabelText(t.fullscreenEnter);
		fireEvent.click(enter);
		await screen.findByLabelText(t.fullscreenExit);
		// Non-Escape keys are ignored while fullscreen.
		fireEvent.keyDown(document, { key: "x" });
		await screen.findByLabelText(t.fullscreenExit);
		fireEvent.keyDown(document, { key: "Escape" });
		await screen.findByLabelText(t.fullscreenEnter);
	});

	it("manifest sheet: toggle, configure, channel focus, and close", async () => {
		const onToggle = vi.fn();
		const onConfigure = vi.fn();
		renderMap({}, { onToggle, onConfigure });
		fireEvent.click(await screen.findByTestId("node-m.pub"));
		// Status badge + config action render for a configurable plugin.
		expect(screen.getByText(t.statusEnabled)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: t.actionConfigure }));
		expect(onConfigure).toHaveBeenCalledTimes(1);
		// Region row focuses the channel pseudo-node.
		fireEvent.click(screen.getByText("portal.sidebar"));
		expect(fitView).toHaveBeenCalledWith({
			nodes: [{ id: "region:portal.sidebar" }],
			duration: 300,
			padding: 0.6,
		});
		// The enable switch reports the flipped value.
		fitView.mockClear();
		fireEvent.click(screen.getByRole("switch"));
		expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "m.pub" }), false);
		// The sheet's close button dismisses it and clears the node param.
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		await vi.waitFor(() =>
			expect(screen.queryByRole("button", { name: t.actionConfigure })).toBeNull(),
		);
	});

	it("manifest sheet shows blocked/disabled/system badges", async () => {
		const statusPlugins: readonly Plugin[] = [
			definePlugin({ id: "s.on", meta: { name: "On" } }),
			definePlugin({ id: "s.off", meta: { name: "Off" } }),
			definePlugin({ id: "s.blocked", meta: { name: "Gated" } }),
			definePlugin({ id: "s.sys", system: true, meta: { name: "Sys" } }),
		];
		renderMap(
			{},
			{
				plugins: statusPlugins,
				enabledSet: new Set(["s.on", "s.blocked", "s.sys"]),
				missingById: new Map([["s.blocked", ["missing.dep"]]]),
			},
		);
		for (const [nodeId, badge] of [
			["s.on", t.statusEnabled],
			["s.off", t.statusDisabled],
			["s.blocked", t.statusBlocked],
			["s.sys", t.statusSystem],
		] as const) {
			fireEvent.click(await screen.findByTestId(`node-${nodeId}`));
			expect(await screen.findByText(badge)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			await vi.waitFor(() => expect(screen.queryByText(badge)).toBeNull());
		}
	});

	it("dims namespace hubs when every member fails the search", async () => {
		renderMap({ searchParams: "?view=hierarchy" });
		await screen.findByTestId("node-ns:m");
		fireEvent.change(screen.getByLabelText(t.searchLabel), { target: { value: "zzz" } });
		await vi.waitFor(() =>
			expect(screen.getByTestId("node-ns:m").querySelector(".opacity-25")).toBeTruthy(),
		);
	});

	it("ignores a node param that matches no graph node", async () => {
		renderMap({ searchParams: "?node=ghost" });
		// Renders fine with no selection — the sheet stays closed.
		expect(await screen.findByTestId("node-m.base")).toBeTruthy();
		expect(screen.queryByRole("button", { name: t.actionConfigure })).toBeNull();
	});

	it("renders a disabled plugin with the dashed treatment", async () => {
		const enabled = new Set(plugins.map((p) => p.id).filter((id) => id !== "m.child"));
		renderMap({}, { enabledSet: enabled });
		const node = await screen.findByTestId("node-m.child");
		expect(node.querySelector(".border-dashed")).toBeTruthy();
	});

	it("deselects the view toggle when its active item is clicked again", async () => {
		const user = userEvent.setup();
		renderMap();
		const channels = screen.getByLabelText(t.viewChannels);
		await user.click(channels);
		await screen.findByTestId("node-region:portal.sidebar");
		// Kind edges draw a `surface:` pseudo-node alongside regions.
		expect(await screen.findByTestId("node-surface:eval-cli")).toBeTruthy();
		// Clicking the active item again empties the selection — the
		// handler ignores the empty value and keeps the current view.
		await user.click(channels);
		expect(await screen.findByTestId("node-region:portal.sidebar")).toBeTruthy();
	});

	it("keeps the sheet closed when a pseudo-node is selected", async () => {
		const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
		renderMap({ onUrlUpdate });
		// Open the manifest on a plugin, then select a channel pseudo-node.
		fireEvent.click(await screen.findByTestId("node-m.pub"));
		await screen.findByRole("button", { name: t.actionConfigure });
		fireEvent.click(screen.getByLabelText(t.viewChannels));
		fireEvent.click(await screen.findByTestId("node-region:portal.sidebar"));
		await vi.waitFor(() =>
			expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.get("node")).toBe(
				"region:portal.sidebar",
			),
		);
		// Pseudo-nodes have no manifest — no configure action renders.
		expect(screen.queryByRole("button", { name: t.actionConfigure })).toBeNull();
	});

	it("drops a whole namespace from the map when every member is hidden", async () => {
		// z.a/z.b both depend on m.base — collapsing m.base hides the
		// entire z.* subtree, so no `ns:z` hub is materialized.
		const zPlugins: readonly Plugin[] = [
			definePlugin({ id: "m.base" }),
			definePlugin({
				id: "z.a",
				requiredDeps: ["m.base"] as unknown as readonly PluginId[],
			}),
			definePlugin({
				id: "z.b",
				requiredDeps: ["m.base"] as unknown as readonly PluginId[],
			}),
		];
		renderMap({ searchParams: "?view=hierarchy&hide=m.base" }, { plugins: zPlugins });
		expect(await screen.findByTestId("node-m.base")).toBeTruthy();
		expect(screen.queryByTestId("node-z.a")).toBeNull();
		expect(screen.queryByTestId("node-ns:z")).toBeNull();
	});
});

describe("ManifestSheet", () => {
	it("renders dep badges for ids missing from the graph as non-interactive", () => {
		// s.off declares a dep on s.ghost, which is not a registry
		// plugin — the badge renders without a focus action.
		const ghostPlugins: readonly Plugin[] = [
			definePlugin({
				id: "s.off",
				meta: { name: "Off" },
				requiredDeps: ["s.ghost"] as unknown as readonly PluginId[],
			}),
		];
		const graph = graphFromPlugins(ghostPlugins);
		const node = graph.nodes.find((n) => n.id === "s.off")!;
		// SheetTitle needs the dialog root context — mount inside a Sheet.
		render(
			<Sheet open onOpenChange={() => {}}>
				<ManifestSheet
					node={node}
					graph={graph}
					status="enabled"
					busy={false}
					t={t}
					onToggle={() => {}}
					onConfigure={() => {}}
					onFocusNode={() => {}}
				/>
			</Sheet>,
		);
		const badge = screen.getByText("s.ghost");
		expect(badge.closest("button")).toBeNull();
	});
});

describe("buildFlow", () => {
	const graph = graphFromPlugins(plugins);
	const allEnabled = new Set(plugins.map((p) => p.id));
	const noStatus = new Map<string, MapStatus>();
	const collapse = { onToggleCollapse: () => {} };

	it("dependencies view: dep edges only, no pseudo-nodes", () => {
		const { nodes, edges } = buildFlow(graph, "dependencies", noStatus, allEnabled, collapse);
		expect(nodes.every((n) => n.type === "plugin")).toBe(true);
		// required + optional on m.base→m.child, then the two deps into x.pub.
		expect(edges).toHaveLength(4);
		expect(edges[0].source).toBe("m.base");
		expect(edges[0].target).toBe("m.child");
	});

	it("channels view: region/kind edges + pseudo-nodes only", () => {
		const { nodes, edges } = buildFlow(graph, "channels", noStatus, allEnabled, collapse);
		expect(edges.every((e) => e.label !== undefined)).toBe(true);
		expect(nodes.some((n) => n.type === "pseudo")).toBe(true);
		// No dep edges drawn.
		expect(edges.some((e) => e.id.includes(":required:"))).toBe(false);
	});

	it("domains view: lanes + cross-domain edges only", () => {
		const { nodes, edges } = buildFlow(graph, "domains", noStatus, allEnabled, collapse);
		const laneIds = nodes.filter((n) => n.type === "lane").map((n) => n.id);
		expect(laneIds.sort()).toEqual(["lane:eval", "lane:platform", "lane:site"]);
		// m.base→m.child is intra-domain (platform→platform) → hidden;
		// the two platform→eval dep edges show.
		expect(edges).toHaveLength(2);
	});

	it("tints required edges from disabled deps destructive", () => {
		const { edges } = buildFlow(graph, "dependencies", noStatus, new Set(["m.child"]), collapse);
		expect(edges[0].style?.stroke).toBe("var(--destructive)");
	});

	it("hierarchy view: one virtual ns node per shared prefix", () => {
		const { nodes } = buildFlow(graph, "hierarchy", noStatus, allEnabled, collapse);
		for (const ns of ["ns:m", "ns:x"]) {
			expect(nodes.some((n) => n.id === ns && n.type === "ns")).toBe(true);
		}
		// Single-member prefixes ("y" → only y.solo) get no node.
		expect(nodes.some((n) => n.id === "ns:y")).toBe(false);
	});

	it("hierarchy view: tree edges give every node a single parent", () => {
		const { edges } = buildFlow(graph, "hierarchy", noStatus, allEnabled, collapse);
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
		const { edges } = buildFlow(graph, "hierarchy", noStatus, allEnabled, collapse);
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
			...collapse,
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

	it("hierarchy view: nested prefixes chain ns→ns containment edges", () => {
		const g = graphFromPlugins(nestedPlugins);
		const { nodes, edges } = buildFlow(
			g,
			"hierarchy",
			new Map<string, MapStatus>(),
			new Set(nestedPlugins.map((p) => p.id)),
			collapse,
		);
		expect(nodes.some((n) => n.id === "ns:n")).toBe(true);
		expect(nodes.some((n) => n.id === "ns:n.one")).toBe(true);
		// ns:n.one's parent prefix is "n" → a containment edge between
		// the two virtual nodes.
		expect(edges.some((e) => e.source === "ns:n" && e.target === "ns:n.one")).toBe(true);
	});

	it("hierarchy view: a disabled member source tints its member edge destructive", () => {
		// m.base→m.child stays member-level (same ns:m); with m.base
		// disabled the required edge renders destructive.
		const enabled = new Set(["m.child", "m.pub", "x.pub", "x.deep", "y.solo"]);
		const { edges } = buildFlow(graph, "hierarchy", noStatus, enabled, collapse);
		const edge = edges.find((e) => e.source === "m.base" && e.target === "m.child");
		expect(edge?.style?.stroke).toBe("var(--destructive)");
	});

	it("domains view: hidden members drop their cross-domain edges", () => {
		const { nodes, edges } = buildFlow(graph, "domains", noStatus, allEnabled, {
			hidden: new Set(["m.child"]),
			...collapse,
		});
		expect(nodes.every((n) => n.id !== "m.child")).toBe(true);
		expect(edges.some((e) => e.source === "m.child" || e.target === "m.child")).toBe(false);
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

	it("positions nested ns→ns containment edges (hierarchy)", async () => {
		const g = graphFromPlugins(nestedPlugins);
		const boxes = await elkPositions(g, "hierarchy");
		expect(boxes.has("ns:n")).toBe(true);
		expect(boxes.has("ns:n.one")).toBe(true);
		// Parent lane sits above its child namespace.
		expect(boxes.get("ns:n")!.y).toBeLessThan(boxes.get("ns:n.one")!.y);
	});
});
