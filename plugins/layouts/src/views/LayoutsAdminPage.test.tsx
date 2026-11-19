// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const fns = vi.hoisted(() => ({
	createLayoutFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateLayoutFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteLayoutFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	layoutDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listLayoutsFn: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));
vi.mock("../fns.ts", () => fns);

import { LayoutsAdminPage, type LayoutRow } from "./LayoutsAdminPage.tsx";

const row = (over: Partial<LayoutRow> = {}): LayoutRow => ({
	id: 1,
	name: "landing",
	description: "Landing body",
	sectionCount: 2,
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

const docWire = (over: Record<string, unknown> = {}) => ({
	id: 1,
	name: "landing",
	description: "Landing body",
	config: '{"sections":[{"id":"s1","title":"Hero","kind":"rich-text","refId":1}]}',
	sectionCount: 1,
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	invalidate.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("LayoutsAdminPage", () => {
	it("renders the empty state", () => {
		render(<LayoutsAdminPage layouts={[]} locale="en" />);
		expect(screen.getByText("Layouts")).toBeTruthy();
		expect(screen.getByText("No layouts yet")).toBeTruthy();
	});

	it("renders rows and opens the editor on edit", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} locale="en" />);
		expect(screen.getByText("landing")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(fns.layoutDocFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByDisplayValue("landing");
		expect(screen.getByDisplayValue("Landing body")).toBeTruthy();
		// The monospace config textarea carries the stored JSON and the
		// preview lists the section title.
		expect(screen.getByDisplayValue(/"kind":"rich-text"/)).toBeTruthy();
		expect(screen.getByText("Hero")).toBeTruthy();
	});

	it("creates a layout through the editor", async () => {
		const user = userEvent.setup();
		fns.createLayoutFn.mockResolvedValue(docWire({ id: 9, name: "new-layout" }));
		render(<LayoutsAdminPage layouts={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New layout/ }));
		await user.type(screen.getByLabelText("Name"), "new-layout");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.createLayoutFn).toHaveBeenCalledWith({
				data: {
					name: "new-layout",
					description: "",
					config: '{"sections":[]}',
				},
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
	});

	it("saves edits through updateLayoutFn", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		fns.updateLayoutFn.mockResolvedValue(docWire({ name: "renamed" }));
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const nameInput = await screen.findByDisplayValue("landing");
		await user.clear(nameInput);
		await user.type(nameInput, "renamed");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updateLayoutFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ id: 1, name: "renamed" }),
			}),
		);
	});

	it("toasts when the doc fetch fails and exits the editor", async () => {
		fns.layoutDocFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByText("Could not load the layout.");
		await screen.findByRole("button", { name: /New layout/ });
	});
});
