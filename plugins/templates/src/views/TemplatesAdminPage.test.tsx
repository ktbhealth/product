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
		await screen.findByText("Could not load the template.");
		await screen.findByRole("button", { name: /New template/ });
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
		await screen.findByText("Could not delete the template.");
	});
});

function fireEventPayload(value: string) {
	fireEvent.change(screen.getByLabelText("Payload (JSON)"), { target: { value } });
}
