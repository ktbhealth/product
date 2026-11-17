// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	createDocumentFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateDocumentFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	documentsFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteDocumentFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
	Link: ({ to, children, ...props }: Record<string, unknown>) => (
		<a href={String(to)} {...props}>
			{children as React.ReactNode}
		</a>
	),
}));
vi.mock("../fns.ts", () => fns);

import type { CollectionWire, DocumentWire, DocumentsPageWire } from "../wire.ts";
import { documentStoreMessages } from "../i18n.ts";
import { DocumentsAdminPage, reasonMessage } from "./DocumentsAdminPage.tsx";

const collection = (over: Partial<CollectionWire> = {}): CollectionWire => ({
	name: "test.notes",
	owner: "test.plugin",
	version: 1,
	fields: {
		title: { kind: "string", required: true },
		count: { kind: "number" },
		active: { kind: "boolean" },
		kind: { kind: "enum", values: ["a", "b"] },
		when: { kind: "date" },
		meta: { kind: "json" },
		tags: { kind: "array", of: { kind: "string" } },
		target: { kind: "ref", collection: "test.targets" },
	},
	contributed: true,
	registered: true,
	recordCount: 0,
	hasMigrations: false,
	...over,
});

const doc = (over: Partial<DocumentWire> = {}): DocumentWire => ({
	id: 1,
	collection: "test.notes",
	data: {
		title: "hello",
		count: 3,
		active: true,
		kind: "a",
		when: 1714523400000,
		meta: { x: 1 },
		tags: ["t1"],
		target: 42,
	},
	schemaVersion: 1,
	ownerId: "u1",
	tenantId: null,
	createdAt: "2024-01-01T00:00:00.000Z",
	updatedAt: "2024-01-02T00:00:00.000Z",
	...over,
});

const pageWire = (over: Partial<DocumentsPageWire> = {}): DocumentsPageWire => ({
	rows: [doc()],
	total: 1,
	...over,
});

const saved = (record: DocumentWire = doc()) => ({ status: "saved", record });

const fieldInput = (name: string) =>
	document.getElementById(`doc-test.notes-${name}`) as HTMLElement;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("reasonMessage", () => {
	it("maps every buildDocumentData failure reason", () => {
		const t = documentStoreMessages("en");
		expect(reasonMessage(t, "invalidJson")).toBe("Invalid JSON");
		expect(reasonMessage(t, "invalidDate")).toBe("Invalid date");
		expect(reasonMessage(t, "invalidNumber")).toBe("Invalid number");
	});
});

describe("DocumentsAdminPage", () => {
	it("renders the documents table with DSL-derived columns", () => {
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		expect(screen.getByText("test.notes")).toBeDefined();
		expect(screen.getByText("hello")).toBeDefined();
		// Scalar + structured cells (formatCell output).
		expect(screen.getByText("3")).toBeDefined();
		expect(screen.getByText("true")).toBeDefined();
		expect(screen.getByText("a")).toBeDefined();
		expect(screen.getByText('{"x":1}')).toBeDefined();
		expect(screen.getByText('["t1"]')).toBeDefined();
		expect(screen.getByText("#42")).toBeDefined();
		expect(screen.getByText("ID")).toBeDefined(); // id column header
	});

	it("renders the empty state", () => {
		render(
			<DocumentsAdminPage
				collection={collection()}
				initialPage={pageWire({ rows: [], total: 0 })}
			/>,
		);
		expect(screen.getByText("No documents yet")).toBeDefined();
	});

	it("paginates through documentsFn", async () => {
		fns.documentsFn.mockResolvedValue(pageWire({ rows: [doc({ id: 26 })], total: 30 }));
		const rows = Array.from({ length: 25 }, (_, i) => doc({ id: i + 1 }));
		render(
			<DocumentsAdminPage collection={collection()} initialPage={pageWire({ rows, total: 30 })} />,
		);
		expect(screen.getByText("Page 1 of 2")).toBeDefined();
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await waitFor(() =>
			expect(fns.documentsFn).toHaveBeenCalledWith({
				data: { collection: "test.notes", limit: 25, offset: 25 },
			}),
		);
		await screen.findByText("26");
		await userEvent.click(screen.getByRole("button", { name: "Previous" }));
		await waitFor(() =>
			expect(fns.documentsFn).toHaveBeenLastCalledWith({
				data: { collection: "test.notes", limit: 25, offset: 0 },
			}),
		);
	});

	it("shows loadFailed when the page fetch is denied", async () => {
		fns.documentsFn.mockResolvedValue(null);
		const rows = Array.from({ length: 25 }, (_, i) => doc({ id: i + 1 }));
		render(
			<DocumentsAdminPage collection={collection()} initialPage={pageWire({ rows, total: 30 })} />,
		);
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText("Could not load documents. Try again.")).toBeDefined();
	});

	it("creates a document through the generated form", async () => {
		fns.createDocumentFn.mockResolvedValue(saved(doc({ id: 9, data: { title: "new" } })));
		fns.documentsFn.mockResolvedValue(pageWire());
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		fireEvent.change(fieldInput("title"), { target: { value: "new" } });
		fireEvent.change(fieldInput("count"), { target: { value: "7" } });
		fireEvent.change(fieldInput("when"), {
			target: { value: "2024-05-01T10:30" },
		});
		// Toggle the boolean on then off to cover both branches.
		const checkbox = screen.getByRole("checkbox");
		await userEvent.click(checkbox);
		await userEvent.click(checkbox);
		fireEvent.change(fieldInput("meta"), { target: { value: '{"a":2}' } });
		fireEvent.change(fieldInput("tags"), { target: { value: '["x"]' } });
		fireEvent.change(fieldInput("target"), { target: { value: "5" } });
		await userEvent.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(fns.createDocumentFn).toHaveBeenCalled());
		const arg = fns.createDocumentFn.mock.calls[0]![0] as {
			data: { collection: string; data: Record<string, unknown> };
		};
		expect(arg.data.collection).toBe("test.notes");
		expect(arg.data.data).toMatchObject({
			title: "new",
			count: 7,
			meta: { a: 2 },
			tags: ["x"],
			target: 5,
			active: false,
		});
		expect(typeof arg.data.data.when).toBe("number");
	});

	it("renders an enum field without declared values", async () => {
		const bare = collection({ fields: { kind: { kind: "enum" } } });
		render(<DocumentsAdminPage collection={bare} initialPage={pageWire({ rows: [] })} />);
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		await userEvent.click(fieldInput("kind"));
		// Only the "None" option exists.
		expect(await screen.findByRole("option", { name: "None" })).toBeDefined();
	});

	it("clears an optional enum through the None option", async () => {
		fns.updateDocumentFn.mockResolvedValue(saved(doc()));
		fns.documentsFn.mockResolvedValue(pageWire());
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByText("hello"));
		await userEvent.click(fieldInput("kind"));
		await userEvent.click(await screen.findByRole("option", { name: "None" }));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(fns.updateDocumentFn).toHaveBeenCalled());
		const arg = fns.updateDocumentFn.mock.calls[0]![0] as {
			data: { data: Record<string, unknown> };
		};
		expect("kind" in arg.data.data).toBe(false);
	});

	it("blocks invalid JSON client-side before calling the fn", async () => {
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		fireEvent.change(fieldInput("title"), { target: { value: "x" } });
		fireEvent.change(fieldInput("meta"), { target: { value: "{bad" } });
		await userEvent.click(screen.getByRole("button", { name: "Create" }));
		await screen.findByText(/meta: Invalid JSON/);
		expect(fns.createDocumentFn).not.toHaveBeenCalled();
	});

	it("surfaces server-side validation issues", async () => {
		fns.createDocumentFn.mockResolvedValue({
			status: "invalid",
			issues: ["title: required field missing"],
		});
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		fireEvent.change(fieldInput("title"), { target: { value: "x" } });
		await userEvent.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText("title: required field missing")).toBeDefined();
	});

	it("shows saveFailed when the fn throws", async () => {
		fns.createDocumentFn.mockRejectedValue(new Error("boom"));
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		fireEvent.change(fieldInput("title"), { target: { value: "x" } });
		await userEvent.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText(/Could not save the document/)).toBeDefined();
	});

	it("shows the busy spinner while a save is in flight", async () => {
		let resolveSave: (v: unknown) => void = () => {};
		fns.createDocumentFn.mockReturnValue(
			new Promise((r) => {
				resolveSave = r;
			}),
		);
		fns.documentsFn.mockResolvedValue(pageWire());
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		fireEvent.change(fieldInput("title"), { target: { value: "x" } });
		await userEvent.click(screen.getByRole("button", { name: "Create" }));
		// While pending the submit label is replaced by the spinner.
		await waitFor(() => expect(screen.queryByRole("button", { name: "Create" })).toBeNull());
		resolveSave(saved(doc({ id: 5 })));
		await waitFor(() => expect(fns.documentsFn).toHaveBeenCalled());
	});

	it("closes the editor via Cancel and via Escape", async () => {
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		expect(screen.getByRole("dialog")).toBeDefined();
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// Reopen and dismiss with Escape → onOpenChange path.
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("opens the editor from the row's edit button", async () => {
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByLabelText("Edit"));
		expect(await screen.findByText("Edit document")).toBeDefined();
		expect((fieldInput("title") as HTMLInputElement).value).toBe("hello");
	});

	it("shows saveFailed when the fn denies the write", async () => {
		fns.createDocumentFn.mockResolvedValue({ status: "denied" });
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByRole("button", { name: /New document/ }));
		fireEvent.change(fieldInput("title"), { target: { value: "x" } });
		await userEvent.click(screen.getByRole("button", { name: "Create" }));
		expect(await screen.findByText(/Could not save the document/)).toBeDefined();
	});

	it("edits a document via row click and updateDocumentFn", async () => {
		fns.updateDocumentFn.mockResolvedValue(saved(doc({ data: { title: "edited" } })));
		fns.documentsFn.mockResolvedValue(pageWire());
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByText("hello"));
		const titleInput = fieldInput("title") as HTMLInputElement;
		expect(titleInput.value).toBe("hello");
		// Enum select: pick "b" through the Base UI popup.
		await userEvent.click(fieldInput("kind"));
		await userEvent.click(await screen.findByRole("option", { name: "b" }));
		// Date prefilled from epoch ms → datetime-local string.
		expect((fieldInput("when") as HTMLInputElement).value).not.toBe("");
		// Boolean starts checked (active: true) → click → false.
		await userEvent.click(screen.getByRole("checkbox"));
		fireEvent.change(titleInput, { target: { value: "edited" } });
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(fns.updateDocumentFn).toHaveBeenCalled());
		const arg = fns.updateDocumentFn.mock.calls[0]![0] as {
			data: { collection: string; id: number; data: Record<string, unknown> };
		};
		expect(arg.data.collection).toBe("test.notes");
		expect(arg.data.id).toBe(1);
		expect(arg.data.data.title).toBe("edited");
		expect(arg.data.data.kind).toBe("b");
		expect(arg.data.data.active).toBe(false);
	});

	it("deletes a document after confirmation", async () => {
		fns.deleteDocumentFn.mockResolvedValue({ status: "deleted" });
		fns.documentsFn.mockResolvedValue(pageWire());
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() =>
			expect(fns.deleteDocumentFn).toHaveBeenCalledWith({
				data: { collection: "test.notes", id: 1 },
			}),
		);
	});

	it("shows the in-use message when delete is blocked by refs", async () => {
		fns.deleteDocumentFn.mockResolvedValue({
			status: "in-use",
			referencedBy: ["other.field"],
		});
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(await within(dialog).findByText(/other\.field/)).toBeDefined();
	});

	it("shows saveFailed when delete is denied", async () => {
		fns.deleteDocumentFn.mockResolvedValue({ status: "denied" });
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(await within(dialog).findByText(/Could not save the document/)).toBeDefined();
	});

	it("closes the delete dialog via its cancel action and via Escape", async () => {
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		// Reopen and dismiss with Escape → onOpenChange path.
		await userEvent.click(screen.getByLabelText("Delete"));
		await screen.findByRole("alertdialog");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	it("shows saveFailed when delete throws or is denied", async () => {
		fns.deleteDocumentFn.mockRejectedValue(new Error("boom"));
		render(<DocumentsAdminPage collection={collection()} initialPage={pageWire()} />);
		await userEvent.click(screen.getByLabelText("Delete"));
		const dialog = await screen.findByRole("alertdialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(await within(dialog).findByText(/Could not save the document/)).toBeDefined();
	});
});
