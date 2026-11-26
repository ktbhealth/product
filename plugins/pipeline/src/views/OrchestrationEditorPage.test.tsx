// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestrationDef } from "@ktb/orchestrator";
import { createElement, type ComponentType, type ReactNode } from "react";

// React Flow needs ResizeObserver/DOMMatrix APIs jsdom lacks — the
// canvas is mocked to a plain listing that still exercises nodeTypes,
// onConnect and onNodeClick. Graph correctness itself is covered by
// graph.test.ts.
const flow = vi.hoisted(() => ({
	lastNodes: [] as { id: string; type: string; data: Record<string, unknown> }[],
	lastEdges: [] as { id: string; source: string; target: string; label?: string }[],
	onConnect: undefined as ((conn: { source: string; target: string }) => void) | undefined,
	onNodeClick: undefined as ((e: unknown, node: { id: string }) => void) | undefined,
}));

vi.mock("@xyflow/react", () => ({
	ReactFlow: ({
		nodes,
		edges,
		nodeTypes,
		onConnect,
		onNodeClick,
		onPaneClick,
		children,
	}: {
		nodes: { id: string; type: string; data: Record<string, unknown> }[];
		edges: { id: string; source: string; target: string; label?: string }[];
		nodeTypes: Record<
			string,
			ComponentType<{ id: string; data: Record<string, unknown>; selected: boolean }>
		>;
		onConnect?: (conn: { source: string; target: string }) => void;
		onNodeClick?: (e: unknown, node: { id: string }) => void;
		onNodesChange?: (changes: unknown[]) => void;
		onPaneClick?: () => void;
		children?: ReactNode;
	}) => {
		flow.lastNodes = nodes;
		flow.lastEdges = edges;
		flow.onConnect = onConnect;
		flow.onNodeClick = onNodeClick;
		return (
			<div data-testid="canvas">
				{nodes.map((n) =>
					createElement(nodeTypes[n.type] as ComponentType<Record<string, unknown>>, {
						key: n.id,
						id: n.id,
						data: n.data,
						selected: false,
					}),
				)}
				<div data-testid="edges">{edges.map((e) => e.id).join(",")}</div>
				<div data-testid="pane" onClick={onPaneClick} />
				{children}
			</div>
		);
	},
	Background: () => null,
	Handle: () => null,
	Controls: () => null,
	Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
	MarkerType: { ArrowClosed: "arrowclosed" },
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		asChild: _asChild,
		...rest
	}: {
		to: string;
		children: React.ReactNode;
		asChild?: boolean;
	}) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
}));

const fns = vi.hoisted(() => ({
	upsertOrchestrationFn: vi.fn<(options: { data: unknown }) => Promise<unknown>>(),
}));
vi.mock("../fns.ts", () => fns);

import { OrchestrationEditorPage } from "./OrchestrationEditorPage.tsx";

const demoDef: OrchestrationDef = {
	id: "demo",
	version: "1",
	nodes: [
		{ id: "emit-a", kind: "emit", on: ["start"], emits: ["go"] },
		{ id: "gate-b", kind: "gate", on: ["go"], emits: ["gate.pass"] },
	],
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("OrchestrationEditorPage", () => {
	it("renders derived nodes, edges and the kind palette", () => {
		render(
			<OrchestrationEditorPage
				mode="edit"
				def={demoDef}
				kinds={["ai", "emit", "gate"]}
				locale="en"
			/>,
		);
		expect(screen.getByText("Orchestration demo")).toBeTruthy();
		expect(flow.lastNodes.map((n) => n.id)).toEqual(
			expect.arrayContaining(["emit-a", "gate-b", "orchestrator"]),
		);
		expect(flow.lastEdges.map((e) => e.id)).toContain("emit-a->gate-b");
		expect(screen.getByRole("button", { name: "ai" })).toBeTruthy();
	});

	it("selecting a node opens the inspector with kind-specific fields", () => {
		render(
			<OrchestrationEditorPage
				mode="edit"
				def={demoDef}
				kinds={["ai", "emit", "gate"]}
				locale="en"
			/>,
		);
		act(() => flow.onNodeClick?.(null, { id: "gate-b" }));
		// The gate inspector shows its structured params labels.
		expect(screen.getByText("Condition path")).toBeTruthy();
		expect(screen.getByText("Pass event")).toBeTruthy();
	});

	it("palette click adds a node to the def", () => {
		render(<OrchestrationEditorPage mode="new" def={null} kinds={["ai", "emit"]} locale="en" />);
		fireEvent.click(screen.getByRole("button", { name: "ai" }));
		expect(flow.lastNodes.map((n) => n.id)).toContain("ai-1");
	});

	it("connect gesture writes the event type into emits/on", () => {
		const three: OrchestrationDef = {
			id: "demo",
			nodes: [
				{ id: "a", kind: "emit", on: ["start"], emits: [] },
				{ id: "b", kind: "emit", on: [], emits: [] },
			],
		};
		render(<OrchestrationEditorPage mode="edit" def={three} kinds={["emit"]} locale="en" />);
		act(() => flow.onConnect?.({ source: "a", target: "b" }));
		// Dialog opens prefilled with the suggested type.
		screen.getByDisplayValue("flow.emit.emit");
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(flow.lastEdges.map((e) => e.id)).toContain("a->b");
	});

	it("save calls the upsert fn with the def", async () => {
		fns.upsertOrchestrationFn.mockResolvedValue({ id: "demo" });
		render(
			<OrchestrationEditorPage mode="edit" def={demoDef} kinds={["emit", "gate"]} locale="en" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(fns.upsertOrchestrationFn).toHaveBeenCalledWith({ data: demoDef });
	});
});
