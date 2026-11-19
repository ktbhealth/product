// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const location = vi.hoisted(() => ({ key: "k0", pathname: "/platform/rich-text" }));
const search = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const fns = vi.hoisted(() => ({
	createRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteRichTextFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	richTextDocFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	richTextUsageFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	listRichTextDocsFn: vi.fn<() => Promise<unknown>>(),
}));
const editor = vi.hoisted(() => ({
	props: null as null | { value?: string; onChange?: (html: string) => void },
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
	useLocation: (opts?: {
		select?: (l: { state: { key: string }; pathname: string }) => unknown;
	}) => {
		const loc = { state: { key: location.key }, pathname: location.pathname };
		return opts?.select === undefined ? loc : opts.select(loc);
	},
	useSearch: () => search.current,
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

import type { Plugin } from "@ktb/kernel";

import { RichTextAdminPage, type RichTextDocRow } from "./RichTextAdminPage.tsx";

const row = (over: Partial<RichTextDocRow> = {}): RichTextDocRow => ({
	id: 1,
	title: "Doc",
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

/** Fake chrome plugin contributing `dialogAction` entries to the
 * rich-text delete region — mirrors what the pages plugin registers. */
const pagesChromePlugin = {
	id: "pages.chrome",
	chrome: [
		{
			id: "pages.delete.actions",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "pages.unlink-unpublish",
					owner: "pages",
					label: "Unlink & unpublish",
					description: "Keep the pages, remove the document link",
				},
			},
		},
		{
			id: "pages.delete.pages",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: {
					id: "pages.delete-pages",
					owner: "pages",
					label: "Delete pages",
					destructive: true,
				},
			},
		},
		{
			// Non-dialogAction content in the region — ignored.
			id: "pages.delete.note",
			region: "rich-text.delete.actions",
			content: { kind: "link", to: "/", label: "not an action" },
		},
		{
			// Owner that never reports referents — must stay hidden.
			id: "ghost.delete.actions",
			region: "rich-text.delete.actions",
			content: {
				kind: "dialogAction",
				action: { id: "ghost.act", owner: "ghost", label: "Ghost action" },
			},
		},
	],
} as unknown as Plugin;

const usagePages = [{ id: "pages", items: [{ id: 5, title: "Home", path: "/" }] }];

const docWire = (over: Record<string, unknown> = {}) => ({
	id: 1,
	title: "Doc",
	content: [{ type: "p", children: [{ text: "body" }] }],
	updatedAt: "2025-01-01T00:00:00.000Z",
	...over,
});

let navSeq = 0;
/** Commit a router navigation: bumps the mocked location key; the page
 * under test then returns to the list (the pane's unmount flush runs). */
const navigate = (rerender: (ui: React.ReactElement) => void, ui: React.ReactElement) => {
	location.key = `k${++navSeq}`;
	rerender(ui);
};

/** The delete dialog disables confirm while usage loads — wait for
 * it to settle, then return the confirm button. */
const confirmButton = async () => {
	// Scope to the dialog — the editor toolbar has its own "Delete" button.
	const dialog = await screen.findByRole("alertdialog");
	const btn = within(dialog).getByText("Delete", { selector: "button" }) as HTMLButtonElement;
	await waitFor(() => expect(btn.disabled).toBe(false));
	return btn;
};

const changeEditor = (html: string) => {
	act(() => {
		editor.props?.onChange?.(html);
	});
};

beforeEach(() => {
	// Default: no referencers. mockReset first so a per-test rejection
	// can't leak into the next case.
	fns.richTextUsageFn.mockReset();
	fns.richTextUsageFn.mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	editor.props = null;
	invalidate.mockResolvedValue(undefined);
	location.key = "k0";
	navSeq = 0;
	search.current = {};
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

	it("flushes a pending title edit on navigation without deleting", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		// Give the created doc some content so exit doesn't take the
		// empty-delete path.
		fns.updateRichTextFn.mockResolvedValue(docWire({ id: 5 }));
		const view = render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		changeEditor("<p>content</p>");
		await user.type(screen.getByLabelText("Title"), "T");
		navigate(view.rerender, <RichTextAdminPage docs={[]} locale="en" />);
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
		const view = render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		navigate(view.rerender, <RichTextAdminPage docs={[]} locale="en" />);
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
		const view = render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		navigate(view.rerender, <RichTextAdminPage docs={[]} locale="en" />);
		expect(await screen.findByText("Could not delete the document.")).toBeTruthy();
	});

	it("deletes explicitly from the editor toolbar via the confirm dialog", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(docWire());
		fns.deleteRichTextFn.mockResolvedValue(true);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByTestId("rich-text-editor");
		await user.click(screen.getByLabelText("Delete"));
		// The toolbar delete opens the shared dialog — nothing is
		// deleted until the confirm inside it.
		await screen.findByText('Delete "Doc"? This cannot be undone.');
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
		await user.click(await confirmButton());
		await waitFor(() => expect(fns.deleteRichTextFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await screen.findByText("Document deleted");
	});

	it("deletes a row from the list after confirmation", async () => {
		const user = userEvent.setup();
		fns.deleteRichTextFn.mockResolvedValue(true);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		expect(screen.getByText('Delete "Doc"? This cannot be undone.')).toBeTruthy();
		await user.click(await confirmButton());
		await waitFor(() => expect(fns.deleteRichTextFn).toHaveBeenCalledWith({ data: { id: 1 } }));
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
		await screen.findByText("Document deleted");
	});

	it("toasts deleteFailed when the list delete fails", async () => {
		const user = userEvent.setup();
		fns.deleteRichTextFn.mockResolvedValue(false);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		await user.click(await confirmButton());
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
		const view = render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Edit"));
		navigate(view.rerender, <RichTextAdminPage docs={[row({})]} locale="en" />);
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
		await user.click(await confirmButton());
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
		await user.click(await confirmButton());
		await screen.findByText("Could not delete the document.");
		expect(screen.getByTestId("rich-text-editor")).toBeTruthy();
	});
	it("shows referents and contributed actions for a referenced doc", async () => {
		const user = userEvent.setup();
		fns.deleteRichTextFn.mockResolvedValue(true);
		fns.richTextUsageFn.mockResolvedValue(usagePages);
		render(<RichTextAdminPage docs={[row({})]} locale="en" plugins={[pagesChromePlugin]} />);
		await user.click(screen.getByLabelText("Delete"));
		// Referents grouped by owner + the two contributed actions;
		// the ghost owner's action stays hidden.
		expect(await screen.findByText("Referenced by")).toBeTruthy();
		expect(screen.getByText("Home")).toBeTruthy();
		expect(screen.getByText(/\(\/\)/)).toBeTruthy();
		expect(screen.getByText("Unlink & unpublish")).toBeTruthy();
		expect(screen.getByText("Delete pages")).toBeTruthy();
		expect(screen.queryByText("Ghost action")).toBeNull();
		// First non-destructive action is preselected → its id is sent.
		await user.click(await confirmButton());
		await waitFor(() =>
			expect(fns.deleteRichTextFn).toHaveBeenCalledWith({
				data: { id: 1, actionId: "pages.unlink-unpublish" },
			}),
		);
	});

	it("sends the selected destructive action id on confirm", async () => {
		const user = userEvent.setup();
		fns.deleteRichTextFn.mockResolvedValue(true);
		fns.richTextUsageFn.mockResolvedValue(usagePages);
		render(<RichTextAdminPage docs={[row({})]} locale="en" plugins={[pagesChromePlugin]} />);
		await user.click(screen.getByLabelText("Delete"));
		await user.click(await screen.findByText("Delete pages"));
		await user.click(await confirmButton());
		await waitFor(() =>
			expect(fns.deleteRichTextFn).toHaveBeenCalledWith({
				data: { id: 1, actionId: "pages.delete-pages" },
			}),
		);
	});

	it("cancelling the extended dialog deletes nothing", async () => {
		const user = userEvent.setup();
		fns.richTextUsageFn.mockResolvedValue(usagePages);
		render(<RichTextAdminPage docs={[row({})]} locale="en" plugins={[pagesChromePlugin]} />);
		await user.click(screen.getByLabelText("Delete"));
		await screen.findByText("Referenced by");
		await user.click(screen.getByText("Cancel", { selector: "button" }));
		await waitFor(() => expect(screen.queryByText("Referenced by")).toBeNull());
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});

	it("hides contributed actions when usage reports no referents", async () => {
		const user = userEvent.setup();
		fns.deleteRichTextFn.mockResolvedValue(true);
		// Owners exist but contributed no dialogAction for them → the
		// referents list renders without a picker and confirm is
		// disabled (a bare delete would hit the FK backstop).
		fns.richTextUsageFn.mockResolvedValue([{ id: "pages", items: [{ id: 5, title: "Home" }] }]);
		render(<RichTextAdminPage docs={[row({})]} locale="en" plugins={[]} />);
		await user.click(screen.getByLabelText("Delete"));
		expect(await screen.findByText("Referenced by")).toBeTruthy();
		expect(screen.queryByText("Unlink & unpublish")).toBeNull();
		const dialog = await screen.findByRole("alertdialog");
		await waitFor(() =>
			expect(
				(within(dialog).getByText("Delete", { selector: "button" }) as HTMLButtonElement).disabled,
			).toBe(true),
		);
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});

	it("shows the failure state and keeps confirm disabled when usage fails", async () => {
		const user = userEvent.setup();
		fns.richTextUsageFn.mockRejectedValue(new Error("boom"));
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		expect(await screen.findByText("Could not delete the document.")).toBeTruthy();
		const dialog = await screen.findByRole("alertdialog");
		await waitFor(() =>
			expect(
				(within(dialog).getByText("Delete", { selector: "button" }) as HTMLButtonElement).disabled,
			).toBe(true),
		);
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});

	it("skips the empty-exit delete and toasts when the doc is referenced", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(
			docWire({ id: 5, content: [{ type: "p", children: [{ text: "" }] }] }),
		);
		fns.richTextUsageFn.mockResolvedValue(usagePages);
		const view = render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		navigate(view.rerender, <RichTextAdminPage docs={[]} locale="en" />);
		expect(await screen.findByText(/referenced elsewhere/)).toBeTruthy();
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});

	it("still attempts the empty-exit delete when the usage check throws", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(
			docWire({ id: 5, content: [{ type: "p", children: [{ text: "" }] }] }),
		);
		fns.richTextUsageFn.mockRejectedValue(new Error("boom"));
		fns.deleteRichTextFn.mockResolvedValue(true);
		const view = render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		navigate(view.rerender, <RichTextAdminPage docs={[]} locale="en" />);
		await waitFor(() => expect(fns.deleteRichTextFn).toHaveBeenCalledWith({ data: { id: 5 } }));
		await screen.findByText("Empty document deleted");
	});

	it("ignores a late usage resolution after the dialog is cancelled", async () => {
		const user = userEvent.setup();
		let resolveUsage: (owners: unknown) => void = () => {};
		fns.richTextUsageFn.mockReturnValue(
			new Promise((resolve) => {
				resolveUsage = resolve;
			}),
		);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		await screen.findByRole("alertdialog");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		// Resolve after close — the cancelled effect must not setState.
		await act(async () => {
			resolveUsage([]);
		});
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});

	it("ignores a late usage rejection after the dialog is cancelled", async () => {
		const user = userEvent.setup();
		let rejectUsage: (error: unknown) => void = () => {};
		fns.richTextUsageFn.mockReturnValue(
			new Promise((_, reject) => {
				rejectUsage = reject;
			}),
		);
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		await screen.findByRole("alertdialog");
		await user.click(screen.getByText("Cancel", { selector: "button" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await act(async () => {
			rejectUsage(new Error("late boom"));
		});
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});

	it("toasts deleteFailed when the list delete fn throws", async () => {
		const user = userEvent.setup();
		fns.deleteRichTextFn.mockRejectedValue(new Error("boom"));
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		await user.click(screen.getByLabelText("Delete"));
		await user.click(await confirmButton());
		expect(await screen.findByText("Could not delete the document.")).toBeTruthy();
	});

	it("passes the picked action through the editor pane delete dialog", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(docWire());
		fns.richTextUsageFn.mockResolvedValue(usagePages);
		fns.deleteRichTextFn.mockResolvedValue(true);
		render(<RichTextAdminPage docs={[row({})]} locale="en" plugins={[pagesChromePlugin]} />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByTestId("rich-text-editor");
		await user.click(screen.getByLabelText("Delete"));
		expect(await screen.findByText("Referenced by")).toBeTruthy();
		await user.click(await screen.findByText("Delete pages"));
		await user.click(await confirmButton());
		await waitFor(() =>
			expect(fns.deleteRichTextFn).toHaveBeenCalledWith({
				data: { id: 1, actionId: "pages.delete-pages" },
			}),
		);
		await screen.findByText("Document deleted");
	});

	it("cancelling the editor pane delete dialog keeps editing", async () => {
		const user = userEvent.setup();
		fns.richTextDocFn.mockResolvedValue(docWire());
		fns.richTextUsageFn.mockResolvedValue(usagePages);
		render(<RichTextAdminPage docs={[row({})]} locale="en" plugins={[pagesChromePlugin]} />);
		await user.click(screen.getByLabelText("Edit"));
		await screen.findByTestId("rich-text-editor");
		await user.click(screen.getByLabelText("Delete"));
		await screen.findByText("Referenced by");
		await user.click(screen.getByText("Cancel", { selector: "button" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		// didExitRef was never claimed — the editor is still usable and a
		// later navigation exit still flushes normally.
		expect(screen.getByTestId("rich-text-editor")).toBeTruthy();
		expect(fns.deleteRichTextFn).not.toHaveBeenCalled();
	});

	it("toasts deleteFailed when the empty-exit delete fn throws", async () => {
		const user = userEvent.setup();
		fns.createRichTextFn.mockResolvedValue(
			docWire({ id: 5, content: [{ type: "p", children: [{ text: "" }] }] }),
		);
		fns.deleteRichTextFn.mockRejectedValue(new Error("boom"));
		const view = render(<RichTextAdminPage docs={[]} locale="en" />);
		await user.click(screen.getByText("New document"));
		await screen.findByTestId("rich-text-editor");
		navigate(view.rerender, <RichTextAdminPage docs={[]} locale="en" />);
		expect(await screen.findByText("Could not delete the document.")).toBeTruthy();
	});

	it("opens the editor directly for a ?doc= deep link", async () => {
		search.current = { doc: "7" };
		fns.richTextDocFn.mockResolvedValue(docWire({ id: 7, title: "Linked" }));
		render(<RichTextAdminPage docs={[row({ id: 7, title: "Linked" })]} locale="en" />);
		await waitFor(() => expect(fns.richTextDocFn).toHaveBeenCalledWith({ data: { id: 7 } }));
		await screen.findByTestId("rich-text-editor");
		expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Linked");
	});

	it("ignores a malformed ?doc= param and shows the list", () => {
		search.current = { doc: "abc" };
		render(<RichTextAdminPage docs={[row({})]} locale="en" />);
		expect(screen.getByText("Doc")).toBeTruthy();
		expect(screen.queryByTestId("rich-text-editor")).toBeNull();
		expect(fns.richTextDocFn).not.toHaveBeenCalled();
	});
});
