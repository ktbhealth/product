// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const fns = vi.hoisted(() => ({
	createSchemaFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateSchemaFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteSchemaFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	schemaDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listSchemasFn: vi.fn<() => Promise<unknown>>(),
	validateSchemaFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));
vi.mock("../fns.ts", () => fns);

import { SchemasAdminPage, type SchemaRow } from "./SchemasAdminPage.tsx";

const row = (over: Partial<SchemaRow> = {}): SchemaRow => ({
	id: 1,
	name: "page-search",
	description: "Page params",
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

const docWire = (over: Record<string, unknown> = {}) => ({
	id: 1,
	name: "page-search",
	description: "Page params",
	schema: '{"type":"object"}',
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	invalidate.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("SchemasAdminPage", () => {
	it("renders the empty state", () => {
		render(<SchemasAdminPage schemas={[]} locale="en" />);
		expect(screen.getByText("Schemas")).toBeTruthy();
		expect(screen.getByText("No schemas yet")).toBeTruthy();
	});

	it("renders rows and opens the editor on edit", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		expect(screen.getByText("page-search")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(fns.schemaDocFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByDisplayValue("page-search");
		expect(screen.getByDisplayValue("Page params")).toBeTruthy();
		expect(screen.getByDisplayValue('{"type":"object"}')).toBeTruthy();
	});

	it("exits the editor via Cancel and re-invalidates", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("page-search");
		// The pane has its own Cancel (back) button plus the dialog's —
		// pick the first rendered one.
		const cancels = screen.getAllByRole("button", { name: "Cancel" });
		await user.click(cancels[0]!);
		// Back on the list — the "New schema" header action returns.
		await screen.findByRole("button", { name: /New schema/ });
	});

	it("loads nothing and toasts when the doc fetch fails", async () => {
		fns.schemaDocFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByRole("button", { name: /New schema/ });
	});

	it("toasts and exits when the doc fetch rejects", async () => {
		fns.schemaDocFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByRole("button", { name: /New schema/ });
	});

	it("creates a schema from the new pane and flips to edit mode", async () => {
		fns.createSchemaFn.mockResolvedValue(docWire({ id: 7, name: "mine" }));
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New schema/ }));
		await user.type(screen.getByLabelText("Name"), "mine");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.createSchemaFn).toHaveBeenCalledWith({
				data: { name: "mine", description: "", schema: "{}" },
			}),
		);
		// After create the pane is in edit mode — the button reads Save.
		await screen.findByRole("button", { name: "Save" });
	});

	it("toasts saveFailed when create returns null", async () => {
		fns.createSchemaFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New schema/ }));
		await user.type(screen.getByLabelText("Name"), "mine");
		await user.click(screen.getByRole("button", { name: "Create" }));
		await screen.findByText("Could not save the schema.");
	});

	it("toasts saveFailed when the save fn rejects", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		fns.updateSchemaFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("page-search");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText("Could not save the schema.");
	});

	it("updates an existing schema on Save", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		fns.updateSchemaFn.mockResolvedValue(docWire({ name: "renamed" }));
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const nameInput = await screen.findByDisplayValue("page-search");
		await user.clear(nameInput);
		await user.type(nameInput, "renamed");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updateSchemaFn).toHaveBeenCalledWith({
				data: {
					id: 1,
					name: "renamed",
					description: "Page params",
					schema: '{"type":"object"}',
				},
			}),
		);
	});

	it("validates against {} and lists issues", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		fns.updateSchemaFn.mockResolvedValue(docWire());
		fns.validateSchemaFn.mockResolvedValue({
			valid: false,
			issues: [{ path: "$", keyword: "required", message: "must have required property 'q'" }],
		});
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("page-search");
		await user.click(screen.getByRole("button", { name: "Validate" }));
		await waitFor(() =>
			expect(fns.validateSchemaFn).toHaveBeenCalledWith({
				data: { schemaId: 1, data: {} },
			}),
		);
		await screen.findByText("Invalid");
		expect(screen.getByText(/required/)).toBeTruthy();
	});

	it("shows Valid when validation passes", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		fns.updateSchemaFn.mockResolvedValue(docWire());
		fns.validateSchemaFn.mockResolvedValue({ valid: true, issues: [] });
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("page-search");
		await user.click(screen.getByRole("button", { name: "Validate" }));
		await screen.findByText("Valid");
	});

	it("skips validation when the persist fails", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		fns.updateSchemaFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("page-search");
		await user.click(screen.getByRole("button", { name: "Validate" }));
		await screen.findByText("Could not save the schema.");
		expect(fns.validateSchemaFn).not.toHaveBeenCalled();
	});

	it("toasts when validateSchemaFn rejects", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		fns.updateSchemaFn.mockResolvedValue(docWire());
		fns.validateSchemaFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("page-search");
		await user.click(screen.getByRole("button", { name: "Validate" }));
		await screen.findByText("Could not save the schema.");
	});

	it("disables Validate while the name is blank", async () => {
		fns.schemaDocFn.mockResolvedValue(docWire());
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const nameInput = await screen.findByDisplayValue("page-search");
		await user.clear(nameInput);
		expect((screen.getByRole("button", { name: "Validate" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("deletes a schema through the confirm dialog", async () => {
		fns.deleteSchemaFn.mockResolvedValue(true);
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(/Delete "page-search"/)).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(fns.deleteSchemaFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByText("Schema deleted");
	});

	it("toasts deleteFailed when the delete resolves false or rejects", async () => {
		fns.deleteSchemaFn.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("boom"));
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row(), row({ id: 2, name: "other" })]} locale="en" />);
		const deletes = screen.getAllByRole("button", { name: "Delete" });
		await user.click(deletes[0]!);
		let dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await screen.findByText("Could not delete the schema.");
		await user.click(deletes[1]!);
		dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await screen.findAllByText("Could not delete the schema.");
	});

	it("cancels the delete dialog without deleting", async () => {
		const user = userEvent.setup();
		render(<SchemasAdminPage schemas={[row()]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(fns.deleteSchemaFn).not.toHaveBeenCalled();
	});
});
