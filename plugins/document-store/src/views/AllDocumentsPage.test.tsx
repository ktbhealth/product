// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
	browseDocumentsFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children, ...props }: Record<string, unknown>) => (
		<a href={String(to)} {...props}>
			{children as React.ReactNode}
		</a>
	),
}));
vi.mock("../fns.ts", () => fns);

import type { CollectionWire, DocumentWire, DocumentsPageWire } from "../wire.ts";
import { AllDocumentsPage } from "./AllDocumentsPage.tsx";

const collection = (over: Partial<CollectionWire> = {}): CollectionWire => ({
	name: "test.notes",
	owner: "test.plugin",
	version: 1,
	fields: { title: { kind: "string", required: true } },
	contributed: true,
	registered: true,
	recordCount: 0,
	hasMigrations: false,
	...over,
});

const doc = (over: Partial<DocumentWire> = {}): DocumentWire => ({
	id: 1,
	collection: "test.notes",
	data: { title: "hello" },
	schemaVersion: 1,
	version: 1,
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

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("AllDocumentsPage", () => {
	it("renders rows with collection, scope and an open link", () => {
		render(
			<AllDocumentsPage
				collections={[collection()]}
				initialPage={pageWire({
					rows: [
						doc({ id: 1, collection: "test.notes", tenantId: 3 }),
						doc({ id: 2, collection: "test.other", ownerId: "", data: { a: 1 } }),
					],
					total: 2,
				})}
			/>,
		);
		expect(screen.getByText("Documents")).toBeDefined();
		expect(screen.getAllByText("test.notes").length).toBeGreaterThan(0);
		expect(screen.getByText("Tenant #3")).toBeDefined();
		expect(screen.getByText("Global")).toBeDefined();
		const links = screen.getAllByRole("link", { name: /open/i });
		expect(links[0]!.getAttribute("href")).toBe("/platform/document-store/test.notes");
	});

	it("filters by collection through browseDocumentsFn", async () => {
		fns.browseDocumentsFn.mockResolvedValue(pageWire({ rows: [], total: 0 }));
		render(
			<AllDocumentsPage
				collections={[collection(), collection({ name: "test.other" })]}
				initialPage={pageWire()}
			/>,
		);
		fireEvent.change(screen.getByLabelText("All collections"), {
			target: { value: "test.other" },
		});
		await waitFor(() =>
			expect(fns.browseDocumentsFn).toHaveBeenCalledWith({
				data: { collection: "test.other", limit: 25, offset: 0 },
			}),
		);
	});

	it("paginates through browseDocumentsFn", async () => {
		fns.browseDocumentsFn.mockResolvedValue(pageWire({ rows: [], total: 250 }));
		render(<AllDocumentsPage collections={[]} initialPage={pageWire({ rows: [], total: 250 })} />);
		fireEvent.click(screen.getByText("Next"));
		await waitFor(() =>
			expect(fns.browseDocumentsFn).toHaveBeenCalledWith({
				data: { limit: 25, offset: 25 },
			}),
		);
	});

	it("shows the empty state and the load-failed message", async () => {
		const { unmount } = render(
			<AllDocumentsPage collections={[]} initialPage={pageWire({ rows: [], total: 0 })} />,
		);
		expect(screen.getByText("No documents")).toBeDefined();
		unmount();

		fns.browseDocumentsFn.mockResolvedValue(null);
		render(
			<AllDocumentsPage
				collections={[collection()]}
				initialPage={pageWire({ rows: [], total: 0 })}
			/>,
		);
		fireEvent.change(screen.getByLabelText("All collections"), {
			target: { value: "test.notes" },
		});
		await waitFor(() =>
			expect(screen.getByText("Could not load documents. Try again.")).toBeDefined(),
		);
	});
});
