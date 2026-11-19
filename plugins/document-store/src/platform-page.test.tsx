// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
	Link: ({ to, children, ...props }: Record<string, unknown>) => (
		<a href={String(to)} {...props}>
			{children as React.ReactNode}
		</a>
	),
}));

vi.mock("./fns.ts", () => ({
	createDocumentFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	updateDocumentFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	documentsFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	browseDocumentsFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
	deleteDocumentFn: vi.fn<(arg?: { data?: unknown }) => Promise<unknown>>(),
}));

import type { PanelPageContext } from "@ktb/kernel";

import {
	collectionNameFromPath,
	DocumentStoreCollectionPage,
	DocumentStoreCollectionsPage,
	DocumentStoreDocumentsPage,
} from "./platform-page.tsx";
import type { CollectionWire, DocumentWire, DocumentsPageWire } from "./wire.ts";

const ctx: PanelPageContext = { plugins: [], locale: "en" };

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

const page = (over: Partial<DocumentsPageWire> = {}): DocumentsPageWire => ({
	rows: [doc()],
	total: 1,
	...over,
});

afterEach(cleanup);

describe("collectionNameFromPath", () => {
	it("extracts the single segment after the base", () => {
		expect(collectionNameFromPath("/platform/document-store/test.notes")).toBe("test.notes");
		expect(collectionNameFromPath("/platform/document-store")).toBeNull();
		expect(collectionNameFromPath("/platform/document-store/")).toBeNull();
		expect(collectionNameFromPath("/platform/document-store/a/b")).toBeNull();
		expect(collectionNameFromPath("/platform/other/x")).toBeNull();
	});
});

describe("DocumentStoreCollectionsPage", () => {
	it("renders the collections table", () => {
		render(<DocumentStoreCollectionsPage data={[collection()]} ctx={ctx} />);
		expect(screen.getByText("test.notes")).toBeDefined();
		expect(screen.getByText("test.plugin")).toBeDefined();
	});

	it("renders the empty state and tolerates bad loader data", () => {
		const { unmount } = render(<DocumentStoreCollectionsPage data={[]} ctx={ctx} />);
		expect(screen.getByText("No collections yet")).toBeDefined();
		unmount();
		render(<DocumentStoreCollectionsPage data="junk" ctx={ctx} />);
		expect(screen.getByText("No collections yet")).toBeDefined();
	});
});

describe("DocumentStoreDocumentsPage", () => {
	it("renders the cross-collection browser", () => {
		render(
			<DocumentStoreDocumentsPage
				data={{
					collections: [collection()],
					page: page({ rows: [doc({ collection: "test.notes" })] }),
				}}
				ctx={ctx}
			/>,
		);
		expect(screen.getByText("Documents")).toBeDefined();
		expect(screen.getAllByText("test.notes").length).toBeGreaterThan(0);
	});

	it("renders nothing on malformed loader data", () => {
		for (const bad of [
			null,
			42,
			"x",
			{ collections: null, page: null },
			{ collections: [], page: "x" },
		]) {
			const { container } = render(<DocumentStoreDocumentsPage data={bad} ctx={ctx} />);
			expect(container.innerHTML).toBe("");
			cleanup();
		}
	});
});

describe("DocumentStoreCollectionPage", () => {
	it("renders the documents browser for a resolved collection", () => {
		render(
			<DocumentStoreCollectionPage data={{ collection: collection(), page: page() }} ctx={ctx} />,
		);
		expect(
			screen.getByText("test.notes").closest("h1, h2, h3") ?? screen.getAllByText("test.notes")[0],
		).toBeDefined();
		expect(screen.getByText("hello")).toBeDefined();
	});

	it("renders nothing when the loader found no collection", () => {
		const { container, unmount } = render(
			<DocumentStoreCollectionPage data={{ collection: null, page: null }} ctx={ctx} />,
		);
		expect(container.innerHTML).toBe("");
		unmount();
		// Malformed loader payloads (non-object, partial shapes) also
		// collapse to the empty render.
		for (const bad of [
			null,
			42,
			"x",
			{ collection: "x", page: null },
			{ collection: {}, page: "x" },
		]) {
			const { container: c } = render(<DocumentStoreCollectionPage data={bad} ctx={ctx} />);
			expect(c.innerHTML).toBe("");
			cleanup();
		}
	});
});
