// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
	onNodesChange: undefined as ((changes: unknown[]) => void) | undefined,
	onPaneClick: undefined as (() => void) | undefined,
}));

vi.mock("@xyflow/react", () => ({
	ReactFlow: ({
		nodes,
		edges,
		nodeTypes,
		onConnect,
		onNodeClick,
		onNodesChange,
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
		flow.onNodesChange = onNodesChange;
		flow.onPaneClick = onPaneClick;
		return (
			<div data-testid="canvas">
				{nodes.map((n) =>
					createElement(nodeTypes[n.type] as ComponentType<Record<string, unknown>>, {
						key: n.id,
						id: n.id,
						data: n.data,
						selected: n.id === "emit-a",
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

// Base UI's Select needs pointer/portal plumbing jsdom lacks; render a
// native <select> with the same value/onValueChange contract (same
// shim as plugins/kv tests).
vi.mock("@ktbhealth/ui/components/select", async () => {
	const React = await import("react");
	const SelectTriggerMock = (props: Record<string, unknown>) =>
		React.createElement("ktb-select-trigger", props);
	const Select = ({
		value,
		onValueChange,
		children,
	}: {
		value?: string | null;
		onValueChange?: (v: string | null) => void;
		children?: React.ReactNode;
	}) => {
		let triggerProps: Record<string, unknown> = {};
		const inner = React.Children.map(children, (child) => {
			if (React.isValidElement(child) && child.type === SelectTriggerMock) {
				const { children: _c, size: _s, ...props } = child.props as Record<string, unknown>;
				triggerProps = props;
				return null;
			}
			return child;
		});
		return React.createElement(
			"select",
			{
				value: value ?? "",
				onChange: (e: { target: { value: string } }) => onValueChange?.(e.target.value),
				...triggerProps,
			},
			inner,
		);
	};
	return {
		Select,
		SelectTrigger: SelectTriggerMock,
		SelectValue: () => null,
		SelectContent: ({ children }: { children?: React.ReactNode }) =>
			React.createElement(React.Fragment, null, children),
		SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) =>
			React.createElement("option", { value }, children),
	};
});

// Capture the Dialog's onOpenChange so the open=true arm (unreachable
// through the real primitive — `open` is fully controlled, there is no
// trigger) can be exercised directly.
const dialogSpy = vi.hoisted(() => ({
	onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));
vi.mock("@ktbhealth/ui/components/dialog", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktbhealth/ui/components/dialog")>();
	return {
		...actual,
		Dialog: (props: { onOpenChange?: (open: boolean) => void }) => {
			dialogSpy.onOpenChange = props.onOpenChange;
			return actual.Dialog(props);
		},
	};
});

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

describe("OrchestrationEditorPage — states and inspector", () => {
	it("renders the not-found state for a missing edit target", () => {
		render(<OrchestrationEditorPage mode="edit" def={null} kinds={["emit"]} locale="en" />);
		expect(screen.getByText("Orchestration not found.")).toBeTruthy();
		expect(screen.getByText("Back to pipelines")).toBeTruthy();
	});

	it("shows the kinds loading hint when the palette is empty", () => {
		render(<OrchestrationEditorPage mode="new" def={null} kinds={[]} locale="en" />);
		expect(screen.getByText("Loading kinds…")).toBeTruthy();
	});

	it("edits node id, on/emits lists, kind and deletes the node", () => {
		render(
			<OrchestrationEditorPage
				mode="edit"
				def={demoDef}
				kinds={["ai", "emit", "gate"]}
				locale="en"
			/>,
		);
		act(() => flow.onNodeClick?.(null, { id: "gate-b" }));

		// Node id patch — the canvas node id follows the def. Renaming
		// deselects (selectedId still points at the old id), so reselect.
		fireEvent.change(screen.getByDisplayValue("gate-b"), { target: { value: "gate-x" } });
		expect(flow.lastNodes.map((n) => n.id)).toContain("gate-x");
		act(() => flow.onNodeClick?.(null, { id: "gate-x" }));

		// on/emits comma lists — parseList trims and drops empties.
		fireEvent.change(screen.getByDisplayValue("go"), {
			target: { value: "go, extra,, " },
		});
		const patched = flow.lastNodes.find((n) => n.id === "gate-x");
		expect((patched?.data.node as { on: string[] }).on).toEqual(["go", "extra"]);
		// The emits list and the gate passEvent field share the default
		// value — the list input renders first.
		fireEvent.change(screen.getAllByDisplayValue("gate.pass")[0]!, {
			target: { value: "gate.pass, done" },
		});

		// Kind change resets params and re-renders the ai inspector.
		const kindSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
		fireEvent.change(kindSelect, { target: { value: "ai" } });
		expect(screen.getByText("Template")).toBeTruthy();

		// Delete removes the node and closes the inspector.
		fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
		expect(flow.lastNodes.map((n) => n.id)).not.toContain("gate-x");
		expect(screen.getByText("Select a node to edit its configuration.")).toBeTruthy();
	});

	it("keeps an off-palette kind selectable and switches back", () => {
		const custom: OrchestrationDef = {
			id: "demo",
			nodes: [{ id: "mystery", kind: "custom.kind", on: [], emits: [] }],
		};
		render(<OrchestrationEditorPage mode="edit" def={custom} kinds={["emit"]} locale="en" />);
		act(() => flow.onNodeClick?.(null, { id: "mystery" }));
		const kindSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
		// The stored kind is appended to the palette options.
		expect([...kindSelect.options].map((o) => o.value)).toEqual(["emit", "custom.kind"]);
		fireEvent.change(kindSelect, { target: { value: "emit" } });
		expect(screen.getByText("Events (JSON array)")).toBeTruthy();
	});

	it("edits gate params: path, equals JSON, pass/fail events", () => {
		const gateDef: OrchestrationDef = {
			id: "demo",
			nodes: [
				{
					id: "g",
					kind: "gate",
					on: [],
					emits: [],
					params: { when: { path: "x.y", equals: 1 }, passEvent: 7, failEvent: "f" },
				},
			],
		};
		render(<OrchestrationEditorPage mode="edit" def={gateDef} kinds={["gate"]} locale="en" />);
		act(() => flow.onNodeClick?.(null, { id: "g" }));

		fireEvent.change(screen.getByDisplayValue("x.y"), { target: { value: "a.b" } });
		// equals is uncontrolled (defaultValue) — blur commits the parse.
		const equals = screen.getByDisplayValue("1");
		fireEvent.change(equals, { target: { value: '{"k":2}' } });
		fireEvent.blur(equals);
		fireEvent.change(equals, { target: { value: "{bad" } });
		fireEvent.blur(equals);
		// passEvent 7 is not a string → falls back to the default label value.
		fireEvent.change(screen.getByDisplayValue("gate.pass"), {
			target: { value: "custom.pass" },
		});
		fireEvent.change(screen.getByDisplayValue("f"), { target: { value: "custom.fail" } });
	});

	it("edits ai params: template, model and the echo switch", async () => {
		const user = userEvent.setup();
		const aiDef: OrchestrationDef = {
			id: "demo",
			nodes: [
				{
					id: "ai-1",
					kind: "ai",
					on: [],
					emits: [],
					params: { template: "hi", model: "m", echo: true },
				},
			],
		};
		render(<OrchestrationEditorPage mode="edit" def={aiDef} kinds={["ai"]} locale="en" />);
		act(() => flow.onNodeClick?.(null, { id: "ai-1" }));
		fireEvent.change(screen.getByDisplayValue("hi"), { target: { value: "bye" } });
		fireEvent.change(screen.getByDisplayValue("m"), { target: { value: "m2" } });
		await user.click(screen.getByRole("switch"));
	});
});

describe("OrchestrationEditorPage — JSON params editors", () => {
	const emitDef = (params?: unknown): OrchestrationDef => ({
		id: "demo",
		nodes: [{ id: "e", kind: "emit", on: [], emits: [], params: params as never }],
	});

	it("emit editor applies a valid events array and flags bad drafts", () => {
		render(
			<OrchestrationEditorPage
				mode="edit"
				def={emitDef({ events: ["a", "b"] })}
				kinds={["emit"]}
				locale="en"
			/>,
		);
		act(() => flow.onNodeClick?.(null, { id: "e" }));
		const area = document.querySelector("textarea")!;
		expect(area).toBeTruthy();

		// Non-array JSON is rejected for emit.
		fireEvent.change(area, { target: { value: '{"a":1}' } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.getByText("Invalid JSON — fix it before saving.")).toBeTruthy();

		// Malformed JSON hits the parse catch.
		fireEvent.change(area, { target: { value: "{oops" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.getByText("Invalid JSON — fix it before saving.")).toBeTruthy();

		// Valid array applies and clears the flag.
		fireEvent.change(area, { target: { value: '["x","y"]' } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.queryByText("Invalid JSON — fix it before saving.")).toBeNull();
	});

	it("emit editor defaults a missing/non-array events param to []", () => {
		for (const params of [undefined, { events: "nope" }]) {
			const { unmount } = render(
				<OrchestrationEditorPage mode="edit" def={emitDef(params)} kinds={["emit"]} locale="en" />,
			);
			act(() => flow.onNodeClick?.(null, { id: "e" }));
			expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("[]");
			unmount();
		}
	});

	it("unknown kinds edit the whole params object and reject non-objects", () => {
		const raw: OrchestrationDef = {
			id: "demo",
			nodes: [
				{ id: "u", kind: "mystery", on: [], emits: [], params: "raw" as never },
				{ id: "v", kind: "mystery", on: [], emits: [], params: { keep: 1 } },
			],
		};
		render(<OrchestrationEditorPage mode="edit" def={raw} kinds={["mystery"]} locale="en" />);

		// Non-object params still round-trip through the raw draft.
		act(() => flow.onNodeClick?.(null, { id: "u" }));
		expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe('"raw"');

		act(() => flow.onNodeClick?.(null, { id: "v" }));
		const area = document.querySelector("textarea")!;
		expect(area).toBeTruthy();

		fireEvent.change(area, { target: { value: "[1,2]" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.getByText("Invalid JSON — fix it before saving.")).toBeTruthy();

		fireEvent.change(area, { target: { value: "null" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.getByText("Invalid JSON — fix it before saving.")).toBeTruthy();

		fireEvent.change(area, { target: { value: "42" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.getByText("Invalid JSON — fix it before saving.")).toBeTruthy();

		fireEvent.change(area, { target: { value: '{"ok":true}' } });
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.queryByText("Invalid JSON — fix it before saving.")).toBeNull();
	});
});

describe("OrchestrationEditorPage — def fields, save and canvas", () => {
	it("edits def-level fields in new mode", () => {
		render(<OrchestrationEditorPage mode="new" def={null} kinds={["emit"]} locale="en" />);
		const details = document.querySelector("details")!;
		const inputs = details.querySelectorAll("input");
		// id / version / description — in DOM order.
		fireEvent.change(inputs[0]!, { target: { value: "my-def" } });
		fireEvent.change(inputs[1]!, { target: { value: "2" } });
		fireEvent.change(inputs[1]!, { target: { value: "" } });
		fireEvent.change(inputs[2]!, { target: { value: "desc" } });
		fireEvent.change(inputs[2]!, { target: { value: "" } });

		const policy = details.querySelector("select") as HTMLSelectElement;
		fireEvent.change(policy, { target: { value: "continue" } });
		fireEvent.change(policy, { target: { value: "halt" } });
	});

	it("reports save failure on false and on throw", async () => {
		fns.upsertOrchestrationFn.mockResolvedValueOnce(false);
		const first = render(
			<OrchestrationEditorPage mode="edit" def={demoDef} kinds={["emit"]} locale="en" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Could not save the orchestration.")).toBeTruthy();
		first.unmount();

		fns.upsertOrchestrationFn.mockRejectedValueOnce(new Error("nope"));
		render(<OrchestrationEditorPage mode="edit" def={demoDef} kinds={["emit"]} locale="en" />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Could not save the orchestration.")).toBeTruthy();
	});

	it("shows the saved marker after a successful save", async () => {
		fns.upsertOrchestrationFn.mockResolvedValueOnce({ id: "demo" });
		render(<OrchestrationEditorPage mode="edit" def={demoDef} kinds={["emit"]} locale="en" />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Saved.")).toBeTruthy();
	});

	it("consumes canvas position changes and ignores other change kinds", () => {
		render(
			<OrchestrationEditorPage mode="edit" def={demoDef} kinds={["emit", "gate"]} locale="en" />,
		);
		act(() =>
			flow.onNodesChange?.([
				{ type: "position", id: "emit-a", position: { x: 100, y: 50 } },
				{ type: "position", id: "ghost" },
				{ type: "remove", id: "emit-a" },
			]),
		);
		const moved = flow.lastNodes.find((n) => n.id === "emit-a") as {
			position?: { x: number; y: number };
		};
		expect(moved.position).toEqual({ x: 100, y: 50 });
	});

	it("pane click deselects; pseudo-node click does not select", () => {
		render(
			<OrchestrationEditorPage mode="edit" def={demoDef} kinds={["emit", "gate"]} locale="en" />,
		);
		act(() => flow.onNodeClick?.(null, { id: "gate-b" }));
		expect(screen.getByText("Condition path")).toBeTruthy();
		act(() => flow.onNodeClick?.(null, { id: "orchestrator" }));
		// Pseudo click is ignored — the inspector keeps the real node.
		expect(screen.getByText("Condition path")).toBeTruthy();
		fireEvent.click(screen.getByTestId("pane"));
		expect(screen.getByText("Select a node to edit its configuration.")).toBeTruthy();
	});

	it("derives unlabeled edges for pairs sharing more than two types", () => {
		const busy: OrchestrationDef = {
			id: "demo",
			nodes: [
				{ id: "a", kind: "emit", on: [], emits: ["x", "y", "z"] },
				{ id: "b", kind: "emit", on: ["x", "y", "z"], emits: [] },
			],
		};
		render(<OrchestrationEditorPage mode="edit" def={busy} kinds={["emit"]} locale="en" />);
		expect(flow.lastEdges.map((e) => e.id)).toContain("a->b");
	});

	it("overflows the on-chip list past four types", () => {
		const wide: OrchestrationDef = {
			id: "demo",
			nodes: [
				{
					id: "w",
					kind: "emit",
					on: ["a", "b", "c", "d", "e"],
					emits: [],
				},
			],
		};
		render(<OrchestrationEditorPage mode="edit" def={wide} kinds={["emit"]} locale="en" />);
		expect(screen.getByText("+1")).toBeTruthy();
	});
});

describe("OrchestrationEditorPage — connect dialog", () => {
	const pair: OrchestrationDef = {
		id: "demo",
		nodes: [
			{ id: "a", kind: "emit", on: ["start"], emits: [] },
			{ id: "b", kind: "emit", on: [], emits: [] },
		],
	};

	it("ignores source-less and target-less connections and an empty event type", () => {
		render(<OrchestrationEditorPage mode="edit" def={pair} kinds={["emit"]} locale="en" />);
		act(() => flow.onConnect?.({ target: "b" } as { source: string; target: string }));
		expect(screen.getByText("Connect nodes")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(flow.lastEdges.map((e) => e.id)).not.toContain("a->b");

		act(() => flow.onConnect?.({ source: "a" } as { source: string; target: string }));
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(flow.lastEdges.map((e) => e.id)).not.toContain("a->b");
	});

	it("edits the event type, confirms, cancels and dismisses", async () => {
		render(<OrchestrationEditorPage mode="edit" def={pair} kinds={["emit"]} locale="en" />);

		act(() => flow.onConnect?.({ source: "a", target: "b" }));
		const input = screen.getByDisplayValue("flow.emit.emit");
		fireEvent.change(input, { target: { value: "custom.ev" } });
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(flow.lastEdges.map((e) => e.id)).toContain("a->b");

		// Cancel closes without wiring.
		act(() => flow.onConnect?.({ source: "a", target: "b" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("Connect nodes")).toBeNull();

		// The header X dismisses through the dialog's own onOpenChange.
		act(() => flow.onConnect?.({ source: "a", target: "b" }));
		expect(screen.getByText("Connect nodes")).toBeTruthy();
		const closeX = document.querySelector("[data-slot='dialog-close']");
		expect(closeX).toBeTruthy();
		fireEvent.click(closeX!);
		await waitFor(() => expect(screen.queryByText("Connect nodes")).toBeNull());

		// onOpenChange(true) is a no-op for the pending state — cover the
		// open arm the controlled primitive never emits on its own.
		act(() => dialogSpy.onOpenChange?.(true));
		expect(flow.lastEdges.map((e) => e.id)).toContain("a->b");
	});
});
