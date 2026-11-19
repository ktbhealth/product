// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const fns = vi.hoisted(() => ({
	createRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	richTextDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listRichTextDocsFn: vi.fn<() => Promise<unknown>>(),
}));
const editor = vi.hoisted(() => ({
	props: null as null | { value?: string; onChange?: (html: string) => void },
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));
vi.mock("../fns.ts", () => fns);
// The real module pulls platejs — stub the editor surface the pane uses.
vi.mock("@ktbhealth/ui/components/rich-text-editor", () => ({
	RichTextEditor: (props: { value?: string; onChange?: (html: string) => void }) => {
		editor.props = props;
		return <div data-testid="rich-text-editor" />;
	},
	richTextToHtml: (value: unknown) => `<p>${JSON.stringify(value)}</p>`,
	htmlToRichText: (html: string) =>
		html === ""
			? [{ type: "p", children: [{ text: "" }] }]
			: [{ type: "p", children: [{ text: html }] }],
}));

import { RichTextAdminPage, type RichTextDocRow } from "./RichTextAdminPage.tsx";

const row = (over: Partial<RichTextDocRow> = {}): RichTextDocRow => ({
	id: 1,
	title: "Doc",
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

const docWire = (over: Record<string, unknown> = {}) => ({
	id: 1,
	title: "Doc",
	content: [{ type: "p", children: [{ text: "body" }] }],
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

const changeEditor = (html: string) => {
	act(() => {
		editor.props?.onChange?.(html);
	});
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	editor.props = null;
	invalidate.mockResolvedValue(undefined);
});

describe("RichTextAdminPage", () => {
	it("renders rows and the empty state", () => {
		const { unmount } = render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		expect(screen.getByText("Doc")).toBeTruthy();
		unmount();
		render(<RichTextAdminPage docs={[]} locale="en" />);
		expect(screen.getByText("No documents yet")).toBeTruthy();
	});

	it("creates a document and opens the editor", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(docWire({ id: 5, title: "Untitled" }));
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await waitFor(() => expect(fns.createRichTextFn).toHaveBeenCalledWith({ data: {} }));
		// Editor pane: back button, title input, editor stub.
		await screen.findByTestId("rich-text-editor");
		expect(screen.getByLabelText("Title")).toBeTruthy();
	});

	it("toasts and stays on the list when create fails", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(null);
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByText("Could not save the document.");
		expect(screen.queryByTestId("rich-text-editor")).toBeNull();
	});

	it("fetches the document when editing from the list", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(docWire({ content: [{ type: "p" }] }));
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await waitFor(() => expect(fns.richTextDocFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByTestId("rich-text-editor");
		expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Doc");
	});

	it("toasts loadFailed and returns to the list when the doc is missing", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(null);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByText("Could not load the document.");
		expect(screen.queryByTestId("rich-text-editor")).toBeNull();
		expect(screen.getByText("Doc")).toBeTruthy();
	});

	it("debounces editor changes into updateRichTextFn", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		fns.updateRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		changeEditor("<p>hi</p>");
		await waitFor(
			() =>
				expect(fns.updateRichTextFn).toHaveBeenCalledWith({
					data: expect.objectContaining({ id: 5, title: "Doc" }),
				}),
			{ timeout: 3000 },
		);
		const call = fns.updateRichTextFn.mock.calls[0]![0] as {
			data: { value: string };
		};
		expect(JSON.parse(call.data.value)).toEqual([{ type: "p", children: [{ text: "<p>hi</p>" }] }]);
	});

	it("flushes a pending title edit on Back without deleting", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		// Give the created doc some content so exit doesn't take the
		// empty-delete path.
		fns.updateRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		changeEditor("<p>content</p>");
		await user.type(screen.getByLabelText("Title"), "T");
		await user.click(screen.getByText("Back"));
		await waitFor(() =>
			expect(fns.updateRichTextFn).toHaveBeenCalledWith({
				data: expect.objectContaining({ id: 5, title: "DocT" }),
			}),
		);
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
		await screen.findByText("No documents yet");
	});

	it("deletes the row and toasts when exiting with an empty document", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(
			docWire({ id: 5, content: [{ type: "p", children: [{ text: "" }] }] }),
		);
		fns.deleteRichTextFn.mockResolvedValue(true);
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		await user.click(screen.getByText("Back"));
		await waitFor(() => expect(fns.deleteRichTextFn).toHaveBeenCalledWith({ data: { id: 5 } }));
		await screen.findByText("Empty document deleted");
		await screen.findByText("No documents yet");
	});

	it("does not delete on StrictMode's dev double-mount", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(
			docWire({ id: 5, content: [{ type: "p", children: [{ text: "" }] }] }),
		);
		fns.deleteRichTextFn.mockResolvedValue(true);
		render(
			<StrictMode>
				<RichTextAdminPage docs={[]} locale="en" />
			</StrictMode>,
		);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		// Let any pending unmount-flush timers fire — the simulated
		// unmount must not reach deleteRichTextFn.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});

	it("toasts deleteFailed when the empty-exit delete fails", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(
			docWire({ id: 5, content: [{ type: "p", children: [{ text: "" }] }] }),
		);
		fns.deleteRichTextFn.mockResolvedValue(false);
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		await user.click(screen.getByText("Back"));
		expect(await screen.findByText("Could not delete the document.")).toBeTruthy();
	});

	it("deletes explicitly from the editor toolbar", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(docWire());
		fns.deleteRichTextFn.mockResolvedValue(true);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByTestId("rich-text-editor");
		await user.click(screen.getByLabelText("Delete"));
		await waitFor(() => expect(fns.deleteRichTextFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByText("Document deleted");
	});

	it("deletes a row from the list after confirmation", async () => {
		const user = userEvent.setup();
		fns.deleteRichTextFn.mockResolvedValue(true);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		expect(screen.getByText('Delete "Doc"? This cannot be undone.')).toBeTruthy();
		await user.click(screen.getByText("Delete", { selector: "button" }));
		await waitFor(() => expect(fns.deleteRichTextFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
	});

	it("toasts deleteFailed when the list delete fails", async () => {
		const user = userEvent.setup();
		fns.deleteRichTextFn.mockResolvedValue(false);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		await user.click(screen.getByText("Delete", { selector: "button" }));
		expect(await screen.findByText("Could not delete the document.")).toBeTruthy();
	});

	it("flushes pending edits on unmount", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(docWire());
		fns.updateRichTextFn.mockResolvedValue(docWire());
		const view = render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByTestId("rich-text-editor");
		changeEditor("<p>typed</p>");
		view.unmount();
		await waitFor(
			() =>
				expect(fns.updateRichTextFn).toHaveBeenCalledWith({
					data: expect.objectContaining({ id: 1 }),
				}),
			{ timeout: 3000 },
		);
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});
	it("toasts saveFailed when the autosave fn returns null", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		fns.updateRichTextFn.mockResolvedValue(null);
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		changeEditor("<p>hi</p>");
		expect(
			await screen.findByText("Could not save the document.", undefined, { timeout: 3000 }),
		).toBeTruthy();
	});

	it("toasts saveFailed when the autosave fn throws", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		fns.updateRichTextFn.mockRejectedValue(new Error("boom"));
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		changeEditor("<p>hi</p>");
		expect(
			await screen.findByText("Could not save the document.", undefined, { timeout: 3000 }),
		).toBeTruthy();
	});

	it("shows the saved indicator after a successful autosave", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		fns.updateRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		changeEditor("<p>hi</p>");
		expect(await screen.findByText("Saved", undefined, { timeout: 3000 })).toBeTruthy();
	});

	it("toasts loadFailed when the doc fetch rejects", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockRejectedValue(new Error("boom"));
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByText("Could not load the document.");
		expect(screen.queryByTestId("rich-text-editor")).toBeNull();
	});

	it("exits without saving or deleting while the doc is still loading", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockReturnValue(new Promise(() => {}));
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await user.click(screen.getByText("Back"));
		await waitFor(() => expect(screen.queryByTestId("rich-text-editor")).toBeNull());
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
		expect(fns.updateRichTextFn).not.toHaveBeenCalled();
	});

	it("keeps the editor open and toasts when the toolbar delete fails", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(docWire());
		fns.deleteRichTextFn.mockResolvedValue(false);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByTestId("rich-text-editor");
		await user.click(screen.getByLabelText("Delete"));
		await screen.findByText("Could not delete the document.");
		expect(screen.getByTestId("rich-text-editor")).toBeTruthy();
	});

	it("keeps the editor open and toasts when the toolbar delete throws", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(docWire());
		fns.deleteRichTextFn.mockRejectedValue(new Error("boom"));
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByTestId("rich-text-editor");
		await user.click(screen.getByLabelText("Delete"));
		await screen.findByText("Could not delete the document.");
		expect(screen.getByTestId("rich-text-editor")).toBeTruthy();
	});
});
