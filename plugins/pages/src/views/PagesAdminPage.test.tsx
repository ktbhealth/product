// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const fns = vi.hoisted(() => ({
	createPageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updatePageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deletePageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	navPagesFn: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
	Link: ({ to, children, ...props }: Record<string, unknown>) => (
		<a href={String(to)} {...props}>
			{children as React.ReactNode}
		</a>
	),
}));
vi.mock("../fns.ts", () => fns);

import { PagesAdminPage, type AdminPageRow } from "./PagesAdminPage.tsx";

const row = (over: Partial<AdminPageRow> = {}): AdminPageRow => ({
	id: 1,
	path: "/about",
	title: "About",
	richTextId: null,
	searchSchemaId: null,
	layoutId: null,
	published: true,
	showInNav: true,
	sortOrder: 2,
	...over,
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PagesAdminPage", () => {
	it("renders rows with status, nav and order badges", () => {
		render(
			<PagesAdminPage
				pages={[
					row({}),
					row({
						id: 2,
						path: "/draft",
						title: "Secret",
						published: false,
						showInNav: false,
					}),
				]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		expect(screen.getByText("/about")).toBeTruthy();
		expect(screen.getByText("/draft")).toBeTruthy();
		expect(screen.getByText("Published")).toBeTruthy();
		expect(screen.getByText("Draft")).toBeTruthy();
		expect(screen.getByText("Shown")).toBeTruthy();
		expect(screen.getByText("Hidden")).toBeTruthy();
		// Published row offers a view link to its public path.
		expect(screen.getByLabelText("View").getAttribute("href")).toBe("/about");
	});

	it("shows the empty state", () => {
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		expect(screen.getByText("No custom pages yet")).toBeTruthy();
	});

	it("defaults the table chrome locale to en when none is passed", () => {
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
			/>,
		);
		expect(screen.getByText("No custom pages yet")).toBeTruthy();
	});

	it("localizes copy for other locales", () => {
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="pt-BR"
			/>,
		);
		expect(screen.getByText("Páginas")).toBeTruthy();
		expect(screen.getByText("Nenhuma página personalizada ainda")).toBeTruthy();
	});

	it("creates a page through the dialog", async () => {
		const user = userEvent.setup();
		fns.createPageFn.mockResolvedValue(row({ id: 9 }));
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New page"));
		await user.type(screen.getByLabelText("Path"), "/new");
		await user.type(screen.getByLabelText("Title"), "New page title");
		// First checkbox is "Published" (DOM order: published, showInNav).
		await user.click(screen.getAllByRole("checkbox")[0]!);
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.createPageFn).toHaveBeenCalledWith({
				data: {
					path: "/new",
					title: "New page title",
					richTextId: null,
					searchSchemaId: null,
					layoutId: null,
					published: true,
					showInNav: false,
					sortOrder: 0,
				},
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
	});

	it("links a page to a rich-text document through the picker", async () => {
		const user = userEvent.setup();
		fns.createPageFn.mockResolvedValue(row({ id: 9 }));
		render(
			<PagesAdminPage
				pages={[]}
				docs={[
					{ id: 7, title: "Handbook" },
					{ id: 8, title: "FAQ" },
				]}
				richTextEnabled
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New page"));
		await user.type(screen.getByLabelText("Path"), "/guide");
		await user.type(screen.getByLabelText("Title"), "Guide");
		// The document field is a Select: combobox trigger + listbox options.
		await user.click(screen.getByRole("combobox", { name: "Content document" }));
		await user.click(await screen.findByRole("option", { name: "Handbook" }));
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.createPageFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ richTextId: 7 }),
			}),
		);
	});

	it("editing a linked page keeps its richTextId and offers a none option", async () => {
		const user = userEvent.setup();
		fns.updatePageFn.mockResolvedValue(row({ richTextId: null }));
		render(
			<PagesAdminPage
				pages={[row({ richTextId: 7 })]}
				docs={[{ id: 7, title: "Handbook" }]}
				richTextEnabled
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		await user.click(screen.getByRole("combobox", { name: "Content document" }));
		// "No document" clears the link → richTextId null on save.
		await user.click(await screen.findByRole("option", { name: "No document" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updatePageFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ id: 1, richTextId: null }),
			}),
		);
	});

	it("updates an existing page", async () => {
		const user = userEvent.setup();
		fns.updatePageFn.mockResolvedValue(row({ title: "Renamed" }));
		render(
			<PagesAdminPage
				pages={[row({})]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		const titleInput = screen.getByLabelText("Title") as HTMLInputElement;
		expect(titleInput.value).toBe("About");
		await user.clear(titleInput);
		await user.type(titleInput, "Renamed");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updatePageFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					id: 1,
					title: "Renamed",
					path: "/about",
				}),
			}),
		);
	});

	it("surfaces a failure message when the fn returns null", async () => {
		const user = userEvent.setup();
		fns.createPageFn.mockResolvedValue(null);
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New page"));
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(screen.getByText(/Could not save/)).toBeTruthy());
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("surfaces a failure message when the fn throws", async () => {
		const user = userEvent.setup();
		fns.createPageFn.mockRejectedValue(new Error("boom"));
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New page"));
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(screen.getByText(/Could not save/)).toBeTruthy());
	});

	it("deletes a page after confirmation", async () => {
		const user = userEvent.setup();
		fns.deletePageFn.mockResolvedValue(true);
		render(
			<PagesAdminPage
				pages={[row({})]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Delete"));
		expect(screen.getByText('Delete "/about"? This cannot be undone.')).toBeTruthy();
		await user.click(screen.getByText("Delete", { selector: "button" }));
		await waitFor(() => expect(fns.deletePageFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
	});

	it("reports a failed delete without invalidating", async () => {
		const user = userEvent.setup();
		fns.deletePageFn.mockResolvedValue(false);
		render(
			<PagesAdminPage
				pages={[row({})]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Delete"));
		fireEvent.click(screen.getByText("Delete", { selector: "button" }));
		await waitFor(() => expect(screen.getByText(/Could not save/)).toBeTruthy());
	});

	it("surfaces a failure message when delete throws", async () => {
		const user = userEvent.setup();
		fns.deletePageFn.mockRejectedValue(new Error("boom"));
		render(
			<PagesAdminPage
				pages={[row({})]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Delete"));
		await user.click(screen.getByText("Delete", { selector: "button" }));
		await waitFor(() => expect(screen.getByText(/Could not save/)).toBeTruthy());
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("edits sort order and the nav flag, then cancels the dialog", async () => {
		const user = userEvent.setup();
		fns.createPageFn.mockResolvedValue(row({ id: 9 }));
		render(
			<PagesAdminPage
				pages={[row({})]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		const order = screen.getByLabelText("Sort order") as HTMLInputElement;
		expect(order.value).toBe("2");
		await user.clear(order);
		await user.type(order, "7");
		// Second checkbox is "Show in navigation" (row starts checked).
		await user.click(screen.getAllByRole("checkbox")[1]!);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByLabelText("Path")).toBeNull());
		expect(fns.updatePageFn).not.toHaveBeenCalled();
		expect(fns.createPageFn).not.toHaveBeenCalled();
	});

	it("closes the form dialog on Escape", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New page"));
		expect(screen.getByLabelText("Path")).toBeTruthy();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByLabelText("Path")).toBeNull());
	});

	it("closes the delete confirm dialog via its cancel action", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[row({})]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Delete"));
		expect(screen.getByText(/cannot be undone/)).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByText(/cannot be undone/)).toBeNull());
		expect(fns.deletePageFn).not.toHaveBeenCalled();
	});

	it("hides the content-document field when rich text is disabled", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New page"));
		expect(screen.queryByRole("combobox", { name: "Content document" })).toBeNull();
		expect(screen.queryByText("Manage documents")).toBeNull();
	});

	it("deep-links Manage rich text to the selected document's editor", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[row({ richTextId: 7 })]}
				docs={[{ id: 7, title: "Handbook" }]}
				richTextEnabled
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		const link = screen.getByText("Manage rich text");
		expect(link.getAttribute("href")).toBe("/platform/rich-text?doc=7");
	});

	it("links Manage documents to the console when no document is selected", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[row({ richTextId: null })]}
				docs={[{ id: 7, title: "Handbook" }]}
				richTextEnabled
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		const link = screen.getByText("Manage documents");
		expect(link.getAttribute("href")).toBe("/platform/rich-text");
	});

	it("hides the search-schema field when schemas are disabled", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[row({ searchSchemaId: 3 })]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		expect(screen.queryByRole("combobox", { name: "Search schema" })).toBeNull();
		expect(screen.queryByText("Manage schemas")).toBeNull();
	});

	it("links a page to a search schema through the picker", async () => {
		const user = userEvent.setup();
		fns.createPageFn.mockResolvedValue(row({ id: 9 }));
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[
					{ id: 3, name: "Filters", description: "Query params" },
					{ id: 4, name: "Sort", description: null },
				]}
				searchSchemaEnabled
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New page"));
		await user.type(screen.getByLabelText("Path"), "/search");
		await user.type(screen.getByLabelText("Title"), "Search");
		await user.click(screen.getByRole("combobox", { name: "Search schema" }));
		await user.click(await screen.findByRole("option", { name: "Filters" }));
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.createPageFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ searchSchemaId: 3 }),
			}),
		);
	});

	it("editing a schema-linked page keeps its searchSchemaId and offers a none option", async () => {
		const user = userEvent.setup();
		fns.updatePageFn.mockResolvedValue(row({ searchSchemaId: null }));
		render(
			<PagesAdminPage
				pages={[row({ searchSchemaId: 3 })]}
				docs={[]}
				richTextEnabled={false}
				schemas={[{ id: 3, name: "Filters", description: null }]}
				searchSchemaEnabled
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		await user.click(screen.getByRole("combobox", { name: "Search schema" }));
		// "No schema" clears the link → searchSchemaId null on save.
		await user.click(await screen.findByRole("option", { name: "No schema" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updatePageFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ id: 1, searchSchemaId: null }),
			}),
		);
	});

	it("deep-links Manage schemas to the schemas console", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[row({ searchSchemaId: 3 })]}
				docs={[]}
				richTextEnabled={false}
				schemas={[{ id: 3, name: "Filters", description: null }]}
				searchSchemaEnabled
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		const link = screen.getByText("Manage schemas");
		expect(link.getAttribute("href")).toBe("/platform/schemas");
	});

	it("hides the layout field when layouts are disabled", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[row({ layoutId: 5 })]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[]}
				layoutEnabled={false}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		expect(screen.queryByText("Manage layouts")).toBeNull();
		expect(screen.queryByRole("combobox", { name: "Layout" })).toBeNull();
	});

	it("links a page to a layout through the picker", async () => {
		const user = userEvent.setup();
		fns.createPageFn.mockResolvedValue(row({ id: 9 }));
		render(
			<PagesAdminPage
				pages={[]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[
					{ id: 5, name: "Landing", description: "Landing body" },
					{ id: 6, name: "Docs", description: null },
				]}
				layoutEnabled
				locale="en"
			/>,
		);
		await user.click(screen.getByText("New page"));
		await user.type(screen.getByLabelText("Path"), "/layout");
		await user.type(screen.getByLabelText("Title"), "Layout page");
		await user.click(screen.getByRole("combobox", { name: "Layout" }));
		await user.click(await screen.findByRole("option", { name: "Landing" }));
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.createPageFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ layoutId: 5 }),
			}),
		);
	});

	it("editing a layout-linked page keeps its layoutId and offers a none option", async () => {
		const user = userEvent.setup();
		fns.updatePageFn.mockResolvedValue(row({ layoutId: null }));
		render(
			<PagesAdminPage
				pages={[row({ layoutId: 5 })]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[{ id: 5, name: "Landing", description: null }]}
				layoutEnabled
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		await user.click(screen.getByRole("combobox", { name: "Layout" }));
		// "No layout" clears the link → layoutId null on save.
		await user.click(await screen.findByRole("option", { name: "No layout" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updatePageFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ id: 1, layoutId: null }),
			}),
		);
	});

	it("deep-links Manage layouts to the layouts console", async () => {
		const user = userEvent.setup();
		render(
			<PagesAdminPage
				pages={[row({ layoutId: 5 })]}
				docs={[]}
				richTextEnabled={false}
				schemas={[]}
				searchSchemaEnabled={false}
				layouts={[{ id: 5, name: "Landing", description: null }]}
				layoutEnabled
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("Edit"));
		const link = screen.getByText("Manage layouts");
		expect(link.getAttribute("href")).toBe("/platform/layouts");
	});
});
