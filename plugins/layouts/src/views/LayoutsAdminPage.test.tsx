// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const templateFns = vi.hoisted(() => ({
	saveTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
	// Honor the `select` projection the component asks for.
	useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) =>
		opts?.select === undefined
			? { pathname: "/platform/layouts" }
			: opts.select({ pathname: "/platform/layouts" }),
}));
vi.mock("../fns.ts", () => fns);
vi.mock("@ktb/templates/fns", () => templateFns);

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
		render(<LayoutsAdminPage layouts={[]} plugins={[]} locale="en" />);
		expect(screen.getByText("Layouts")).toBeTruthy();
		expect(screen.getByText("No layouts yet")).toBeTruthy();
	});

	it("renders rows and opens the editor on edit", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
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
		render(<LayoutsAdminPage layouts={[]} plugins={[]} locale="en" />);
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
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
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
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		expect(await screen.findByText("Could not load the layout.")).toBeTruthy();
		expect(await screen.findByRole("button", { name: /New layout/ })).toBeTruthy();
	});

	it("toasts and exits when the doc fetch rejects", async () => {
		fns.layoutDocFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		expect(await screen.findByText("Could not load the layout.")).toBeTruthy();
		expect(await screen.findByRole("button", { name: /New layout/ })).toBeTruthy();
	});

	it("exits the editor via Cancel and re-invalidates", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("landing");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		// Back on the list — the "New layout" header action returns.
		await screen.findByRole("button", { name: /New layout/ });
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
	});

	it("deletes a layout through the confirm dialog", async () => {
		fns.deleteLayoutFn.mockResolvedValue(true);
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(/Delete "landing"/)).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(fns.deleteLayoutFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByText("Layout deleted");
	});

	it("toasts deleteFailed when the delete resolves false or rejects", async () => {
		fns.deleteLayoutFn.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("boom"));
		const user = userEvent.setup();
		render(
			<LayoutsAdminPage
				layouts={[row(), row({ id: 2, name: "other" })]}
				plugins={[]}
				locale="en"
			/>,
		);
		const deletes = screen.getAllByRole("button", { name: "Delete" });
		await user.click(deletes[0]!);
		let dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(await screen.findByText("Could not delete the layout.")).toBeTruthy();
		await user.click(deletes[1]!);
		dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect((await screen.findAllByText("Could not delete the layout.")).length).toBeGreaterThan(0);
	});

	it("dismisses a list-view toast", async () => {
		fns.deleteLayoutFn.mockResolvedValue(true);
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await screen.findByText("Layout deleted");
		await user.click(screen.getByLabelText("Dismiss notification"));
		await waitFor(() => expect(screen.queryByText("Layout deleted")).toBeNull());
	});

	it("dismisses an editor-view toast", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		fns.updateLayoutFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("landing");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText(/Could not save the layout/);
		await user.click(screen.getByLabelText("Dismiss notification"));
		await waitFor(() => expect(screen.queryByText(/Could not save the layout/)).toBeNull());
	});

	it("toasts saveFailed when the save fn rejects", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		fns.updateLayoutFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("landing");
		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(/Could not save the layout/)).toBeTruthy();
	});

	it("renders a null description and falls back to English without a locale", async () => {
		render(<LayoutsAdminPage layouts={[row({ description: null })]} plugins={[]} />);
		expect(screen.getByText("landing")).toBeTruthy();
		// English copy — no locale prop.
		expect(screen.getByText("Layouts")).toBeTruthy();
		// The editor still loads with an empty description field.
		fns.layoutDocFn.mockResolvedValue(docWire({ description: null }));
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("landing");
		expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("");
	});

	it("edits the description and config fields and saves them", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		fns.updateLayoutFn.mockResolvedValue(docWire());
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("landing");
		const description = screen.getByLabelText("Description") as HTMLInputElement;
		await user.clear(description);
		await user.type(description, "docs");
		const config = screen.getByLabelText("Layout config (JSON)") as HTMLTextAreaElement;
		fireEvent.change(config, { target: { value: '{"sections":[]}' } });
		expect(config.value).toBe('{"sections":[]}');
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updateLayoutFn).toHaveBeenCalledWith({
				data: {
					id: 1,
					name: "landing",
					description: "docs",
					config: '{"sections":[]}',
				},
			}),
		);
	});

	it("shows an empty preview for malformed configs and #N for untitled sections", async () => {
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New layout/ }));
		const config = screen.getByLabelText("Layout config (JSON)") as HTMLTextAreaElement;
		// Invalid JSON → parse catch → no sections.
		fireEvent.change(config, { target: { value: "not json" } });
		expect(screen.getByText("No sections")).toBeTruthy();
		// Non-object JSON → early return → no sections.
		fireEvent.change(config, { target: { value: "5" } });
		expect(screen.getByText("No sections")).toBeTruthy();
		fireEvent.change(config, { target: { value: "null" } });
		expect(screen.getByText("No sections")).toBeTruthy();
		// `sections` present but not an array → no sections.
		fireEvent.change(config, { target: { value: '{"sections":{}}' } });
		expect(screen.getByText("No sections")).toBeTruthy();
		// Non-object entries are filtered out; a missing/empty title
		// falls back to its `#N` position label.
		fireEvent.change(config, {
			target: { value: '{"sections":[42,null,{"title":""},{"title":"Two"},{}]}' },
		});
		expect(screen.getByText("#1")).toBeTruthy();
		expect(screen.getByText("Two")).toBeTruthy();
		expect(screen.getByText("#3")).toBeTruthy();
	});

	it("ignores a doc fetch that resolves after the pane unmounts", async () => {
		let resolveDoc!: (doc: unknown) => void;
		fns.layoutDocFn.mockReturnValue(
			new Promise((resolve) => {
				resolveDoc = resolve;
			}),
		);
		const user = userEvent.setup();
		const { unmount } = render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(fns.layoutDocFn).toHaveBeenCalled());
		unmount();
		resolveDoc(docWire());
		await Promise.resolve();
	});

	it("ignores a doc fetch that rejects after the pane unmounts", async () => {
		let rejectDoc!: (error: unknown) => void;
		fns.layoutDocFn.mockReturnValue(
			new Promise((_, reject) => {
				rejectDoc = reject;
			}),
		);
		const user = userEvent.setup();
		const { unmount } = render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(fns.layoutDocFn).toHaveBeenCalled());
		unmount();
		rejectDoc(new Error("boom"));
		await Promise.resolve();
	});

	it("saves a layout as a template through the shared dialog", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		templateFns.saveTemplateFn.mockResolvedValue({ id: 5 });
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Save as template" }));
		const dialog = await screen.findByRole("alertdialog");
		// The dialog prefills the template name/description from the
		// layout doc fetched through layoutDocFn.
		expect(within(dialog).getByDisplayValue("landing")).toBeTruthy();
		expect(within(dialog).getByDisplayValue("Landing body")).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(templateFns.saveTemplateFn).toHaveBeenCalledWith({
				data: {
					kind: "layout",
					name: "landing",
					description: "Landing body",
					source: {
						name: "landing",
						description: "Landing body",
						config: docWire().config,
					},
				},
			}),
		);
		await screen.findByText("Template saved");
	});

	it("toasts templateSaveFailed when the save fn resolves null", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		templateFns.saveTemplateFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Save as template" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Could not save the template.")).toBeTruthy();
	});

	it("toasts loadFailed when the template source doc is missing", async () => {
		fns.layoutDocFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Save as template" }));
		await screen.findByText("Could not load the layout.");
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("toasts loadFailed when the template source fetch rejects", async () => {
		fns.layoutDocFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Save as template" }));
		await screen.findByText("Could not load the layout.");
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("toasts templateSaveFailed when the save fn rejects", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		templateFns.saveTemplateFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Save as template" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Could not save the template.")).toBeTruthy();
	});

	it("closes the template dialog on cancel", async () => {
		fns.layoutDocFn.mockResolvedValue(docWire());
		const user = userEvent.setup();
		render(<LayoutsAdminPage layouts={[row()]} plugins={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Save as template" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(templateFns.saveTemplateFn).not.toHaveBeenCalled();
	});
});
