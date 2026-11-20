// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const fns = vi.hoisted(() => ({
	saveTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	templateDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listTemplatesFn: vi.fn<() => Promise<unknown>>(),
	instantiateTemplateFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));
vi.mock("../fns.ts", () => fns);
// The kind picker is exercised through a native <select> stub so tests
// can fire onValueChange without driving the Base UI popover.
vi.mock("@ktbhealth/ui/components/select", async () => {
	const { createElement } = await import("react");
	type Props = {
		children?: unknown;
		value?: string;
		onValueChange?: (value: string | null) => void;
	};
	return {
		// Children render inline so the <option>s stay inside the <select>;
		// SelectTrigger/SelectValue/SelectContent resolve to null/fragment.
		// The extra button emulates Base UI's clear-to-null onValueChange.
		Select: ({ value, onValueChange, children }: Props) =>
			createElement(
				"span",
				null,
				createElement(
					"select",
					{
						"data-testid": "kind-select",
						value,
						onChange: (e: { target: { value: string } }) => onValueChange?.(e.target.value),
					},
					children as never,
				),
				createElement(
					"button",
					{
						"data-testid": "kind-clear",
						type: "button",
						onClick: () => onValueChange?.(null),
					},
					"clear",
				),
			),
		SelectTrigger: () => null,
		SelectValue: () => null,
		// Fragment keeps the <option> children inside the parent <select>.
		SelectContent: ({ children }: Props) => children as never,
		SelectItem: ({ value, children }: Props) =>
			createElement("option", { value }, children as never),
	};
});

import {
	TemplatesAdminPage,
	type TemplateKindInfo,
	type TemplateRow,
} from "./TemplatesAdminPage.tsx";

const KINDS: readonly TemplateKindInfo[] = [
	{ kind: "layout", label: "Layout" },
	{ kind: "page", label: "Page" },
];

const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
	id: 1,
	kind: "layout",
	name: "landing",
	description: "Landing snapshot",
	createdBy: "admin@x.com",
	createdAt: "2025-01-01T00:00:00.000Z",
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

const docWire = (over: Record<string, unknown> = {}) => ({
	id: 1,
	kind: "layout",
	name: "landing",
	description: "Landing snapshot",
	createdBy: "admin@x.com",
	payload: { name: "landing", description: null, config: { sections: [] } },
	createdAt: "2025-01-01T00:00:00.000Z",
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	invalidate.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("TemplatesAdminPage", () => {
	it("renders the empty state", () => {
		render(<TemplatesAdminPage rows={[]} kinds={KINDS} locale="en" />);
		expect(screen.getByText("Templates")).toBeTruthy();
		expect(screen.getByText("No templates yet")).toBeTruthy();
	});

	it("shows the no-kinds hint when nothing is registered", () => {
		render(<TemplatesAdminPage rows={[]} kinds={[]} locale="en" />);
		expect(screen.getByText("No template kinds are registered yet.")).toBeTruthy();
	});

	it("groups rows under their kind label", () => {
		render(
			<TemplatesAdminPage
				rows={[row(), row({ id: 2, kind: "page", name: "about" })]}
				kinds={KINDS}
				locale="en"
			/>,
		);
		expect(screen.getByText("landing")).toBeTruthy();
		expect(screen.getByText("about")).toBeTruthy();
		expect(screen.getByText(/Layout \(1\)/)).toBeTruthy();
		expect(screen.getByText(/Page \(1\)/)).toBeTruthy();
	});

	it("lists rows of unregistered kinds under the raw kind id", () => {
		render(<TemplatesAdminPage rows={[row({ kind: "ghost" })]} kinds={KINDS} locale="en" />);
		expect(screen.getByText(/ghost \(1\)/)).toBeTruthy();
	});

	it("creates a template through the editor", async () => {
		const user = userEvent.setup();
		fns.saveTemplateFn.mockResolvedValue(docWire({ id: 9, name: "fresh" }));
		render(<TemplatesAdminPage rows={[]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New template/ }));
		await user.type(screen.getByLabelText("Name"), "fresh");
		fireEventPayload('{"wrapped":1}');
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.saveTemplateFn).toHaveBeenCalledWith({
				data: {
					kind: "layout",
					name: "fresh",
					description: "",
					payload: { wrapped: 1 },
				},
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
	});

	it("blocks save and flags invalid JSON payloads", async () => {
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New template/ }));
		await user.type(screen.getByLabelText("Name"), "fresh");
		const payload = screen.getByLabelText("Payload (JSON)") as HTMLTextAreaElement;
		fireEvent.change(payload, { target: { value: "not json" } });
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(screen.getByText("Payload is not valid JSON.")).toBeTruthy();
		expect(fns.saveTemplateFn).not.toHaveBeenCalled();
	});

	it("edits name/description/payload through updateTemplateFn", async () => {
		fns.templateDocFn.mockResolvedValue(docWire());
		fns.updateTemplateFn.mockResolvedValue(docWire({ name: "renamed" }));
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const nameInput = await screen.findByDisplayValue("landing");
		await user.clear(nameInput);
		await user.type(nameInput, "renamed");
		// Kind is immutable on edit — shown as text, not a picker.
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.getByText("Layout")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fns.updateTemplateFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					id: 1,
					name: "renamed",
					payload: docWire().payload,
				}),
			}),
		);
	});

	it("toasts when the doc fetch fails and exits the editor", async () => {
		fns.templateDocFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		expect(await screen.findByText("Could not load the template.")).toBeTruthy();
		expect(await screen.findByRole("button", { name: /New template/ })).toBeTruthy();
	});

	it("deletes a template through the confirm dialog", async () => {
		fns.deleteTemplateFn.mockResolvedValue(true);
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(/Delete "landing"/)).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(fns.deleteTemplateFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByText("Template deleted");
	});

	it("toasts deleteFailed when the delete resolves false", async () => {
		fns.deleteTemplateFn.mockResolvedValue(false);
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(await screen.findByText("Could not delete the template.")).toBeTruthy();
	});

	it("renders rows with null description/createdBy and without a locale", () => {
		render(
			<TemplatesAdminPage rows={[row({ description: null, createdBy: null })]} kinds={KINDS} />,
		);
		expect(screen.getByText("landing")).toBeTruthy();
	});

	it("dismisses the toast in the list view", async () => {
		fns.deleteTemplateFn.mockResolvedValue(true);
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await screen.findByText("Template deleted");
		await user.click(screen.getByLabelText("Dismiss notification"));
		await waitFor(() => expect(screen.queryByText("Template deleted")).toBeNull());
	});

	it("edits description, switches kind and saves through saveTemplateFn", async () => {
		fns.saveTemplateFn.mockResolvedValue(docWire({ id: 9, kind: "page", name: "fresh" }));
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New template/ }));
		await user.type(screen.getByLabelText("Name"), "fresh");
		const description = screen.getByLabelText("Description") as HTMLInputElement;
		await user.type(description, "notes");
		fireEvent.change(screen.getByTestId("kind-select"), { target: { value: "page" } });
		fireEventPayload('{"wrapped":1}');
		await user.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(fns.saveTemplateFn).toHaveBeenCalledWith({
				data: {
					kind: "page",
					name: "fresh",
					description: "notes",
					payload: { wrapped: 1 },
				},
			}),
		);
	});

	it("creates successfully, flips to edit mode and shows the saved state", async () => {
		fns.saveTemplateFn.mockResolvedValue(docWire({ id: 9 }));
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New template/ }));
		await user.type(screen.getByLabelText("Name"), "fresh");
		fireEventPayload('{"wrapped":1}');
		await user.click(screen.getByRole("button", { name: "Create" }));
		await screen.findByText("Saved");
		// docId flipped → the kind picker is replaced by the kind label.
		await waitFor(() => expect(screen.queryByTestId("kind-select")).toBeNull());
		expect(screen.getByText("Layout")).toBeTruthy();
		// The button now reads "Save" (edit mode).
		expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
	});

	it("clears the kind through onValueChange(null) and disables save", async () => {
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New template/ }));
		await user.type(screen.getByLabelText("Name"), "fresh");
		fireEventPayload('{"wrapped":1}');
		fireEvent.click(screen.getByTestId("kind-clear"));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Create" })).toHaveProperty("disabled", true),
		);
	});

	it("saves edits successfully through updateTemplateFn", async () => {
		fns.templateDocFn.mockResolvedValue(docWire());
		fns.updateTemplateFn.mockResolvedValue(docWire({ name: "renamed" }));
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const name = (await screen.findByDisplayValue("landing")) as HTMLInputElement;
		await user.clear(name);
		await user.type(name, "renamed");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText("Saved");
		await waitFor(() =>
			expect(fns.updateTemplateFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ id: 1, name: "renamed" }),
			}),
		);
	});

	it("toasts saveFailed when the create save resolves null", async () => {
		fns.saveTemplateFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New template/ }));
		await user.type(screen.getByLabelText("Name"), "fresh");
		fireEventPayload('{"wrapped":1}');
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("Could not save the template.")).toBeTruthy();
	});

	it("toasts saveFailed when the save fn rejects", async () => {
		fns.saveTemplateFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: /New template/ }));
		await user.type(screen.getByLabelText("Name"), "fresh");
		fireEventPayload('{"wrapped":1}');
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("Could not save the template.")).toBeTruthy();
	});

	it("dismisses the toast inside the editor pane", async () => {
		fns.templateDocFn.mockResolvedValue(docWire());
		fns.updateTemplateFn.mockResolvedValue(null);
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByDisplayValue("landing");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText("Could not save the template.");
		await user.click(screen.getByLabelText("Dismiss notification"));
		await waitFor(() => expect(screen.queryByText("Could not save the template.")).toBeNull());
	});

	it("falls back to the raw kind and empty picker state for unregistered kinds", async () => {
		fns.templateDocFn.mockResolvedValue(docWire({ kind: "ghost" }));
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row({ kind: "ghost" })]} kinds={[]} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		// kindLabel falls back to the raw kind id; the doc's description
		// null exercises the ?? "" fallback.
		await screen.findByDisplayValue("landing");
		expect(screen.getByText("ghost")).toBeTruthy();
	});

	it("loads a doc with a null description in the editor", async () => {
		fns.templateDocFn.mockResolvedValue(docWire({ description: null }));
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const description = (await screen.findByLabelText("Description")) as HTMLInputElement;
		expect(description.value).toBe("");
	});

	it("toasts and exits when the doc fetch rejects", async () => {
		fns.templateDocFn.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		expect(await screen.findByText("Could not load the template.")).toBeTruthy();
		expect(await screen.findByRole("button", { name: /New template/ })).toBeTruthy();
	});

	it("ignores a doc fetch that resolves after the pane unmounts", async () => {
		let resolveDoc!: (value: unknown) => void;
		fns.templateDocFn.mockReturnValue(
			new Promise((resolve) => {
				resolveDoc = resolve;
			}),
		);
		const user = userEvent.setup();
		const { unmount } = render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(fns.templateDocFn).toHaveBeenCalled());
		unmount();
		resolveDoc(docWire());
		await Promise.resolve();
	});

	it("ignores a doc fetch that rejects after the pane unmounts", async () => {
		let rejectDoc!: (error: unknown) => void;
		fns.templateDocFn.mockReturnValue(
			new Promise((_, reject) => {
				rejectDoc = reject;
			}),
		);
		const user = userEvent.setup();
		const { unmount } = render(<TemplatesAdminPage rows={[row()]} kinds={KINDS} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		await waitFor(() => expect(fns.templateDocFn).toHaveBeenCalled());
		unmount();
		rejectDoc(new Error("boom"));
		await Promise.resolve();
	});
});

function fireEventPayload(value: string) {
	fireEvent.change(screen.getByLabelText("Payload (JSON)"), { target: { value } });
}
