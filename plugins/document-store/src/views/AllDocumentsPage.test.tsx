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

	it("paginates backwards through browseDocumentsFn", async () => {
		fns.browseDocumentsFn.mockResolvedValue(pageWire({ rows: [doc({ id: 26 })], total: 250 }));
		render(<AllDocumentsPage collections={[]} initialPage={pageWire({ rows: [], total: 250 })} />);
		fireEvent.click(screen.getByText("Next"));
		await waitFor(() =>
			expect(fns.browseDocumentsFn).toHaveBeenCalledWith({ data: { limit: 25, offset: 25 } }),
		);
		fireEvent.click(screen.getByText("Previous"));
		await waitFor(() =>
			expect(fns.browseDocumentsFn).toHaveBeenNthCalledWith(2, {
				data: { limit: 25, offset: 0 },
			}),
		);
	});

	it("previews undefined, unserializable and oversized payloads", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		render(
			<AllDocumentsPage
				collections={[]}
				initialPage={pageWire({
					rows: [
						doc({ id: 1, data: undefined as unknown as DocumentWire["data"] }),
						doc({ id: 2, data: circular as DocumentWire["data"] }),
						doc({ id: 3, data: { title: "x".repeat(200) } }),
					],
					total: 3,
				})}
			/>,
		);
		// JSON.stringify(undefined) is undefined → String(value) fallback.
		expect(screen.getByText("undefined")).toBeTruthy();
		// Circular data throws inside stringify → catch → String(value).
		expect(screen.getByText("[object Object]")).toBeTruthy();
		// The oversized payload truncates at PREVIEW_LENGTH with an ellipsis.
		expect(screen.getByText((text) => text.endsWith("…"))).toBeTruthy();
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
