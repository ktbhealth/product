// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children, ...props }: Record<string, unknown>) => (
		<a href={String(to)} {...props}>
			{children as React.ReactNode}
		</a>
	),
}));

import type { CollectionWire } from "../wire.ts";
import { CollectionsAdminPage } from "./CollectionsAdminPage.tsx";

const collection = (over: Partial<CollectionWire> = {}): CollectionWire => ({
	name: "test.notes",
	owner: "test.plugin",
	version: 1,
	fields: { title: { kind: "string" } },
	contributed: true,
	registered: true,
	recordCount: 0,
	...over,
});

afterEach(cleanup);

describe("CollectionsAdminPage", () => {
	it("renders rows with status badges, counts and field totals", () => {
		render(
			<CollectionsAdminPage
				collections={[
					collection(),
					collection({
						name: "legacy.rows",
						owner: "",
						contributed: false,
						registered: true,
						recordCount: 7,
						fields: {},
					}),
					collection({
						name: "fresh.items",
						owner: "other.plugin",
						contributed: true,
						registered: false,
						recordCount: 3,
						fields: {
							a: { kind: "string" },
							b: { kind: "number" },
							c: { kind: "boolean" },
						},
					}),
				]}
			/>,
		);
		expect(screen.getByText("test.notes")).toBeDefined();
		expect(screen.getByText("test.plugin")).toBeDefined();
		expect(screen.getByText("legacy.rows")).toBeDefined();
		expect(screen.getByText("fresh.items")).toBeDefined();
		// Owner "" renders the "None" placeholder.
		expect(screen.getByText("None")).toBeDefined();
		// Raw field counts (1, 0, 3).
		expect(screen.getAllByRole("cell").map((c) => c.textContent)).toContain("1");
		expect(screen.getAllByText("Contributed").length).toBe(2);
		expect(screen.getByText("DB only")).toBeDefined();
		expect(screen.getByText("Unregistered")).toBeDefined();
		// Record counts appear as right-aligned cells.
		expect(screen.getAllByText("7").length).toBeGreaterThan(0);
	});

	it("links each row to its collection browser page", () => {
		render(<CollectionsAdminPage collections={[collection()]} />);
		const link = screen.getByLabelText("Open");
		expect(link.getAttribute("href")).toBe("/platform/document-store/test.notes");
	});

	it("renders the empty state", () => {
		render(<CollectionsAdminPage collections={[]} />);
		expect(screen.getByText("No collections yet")).toBeDefined();
	});

	it("localizes through the DB i18n slice and locale prop", () => {
		render(
			<CollectionsAdminPage
				collections={[]}
				locale="pt-BR"
				i18n={{ locale: "pt-BR", catalog: {} }}
			/>,
		);
		expect(screen.getByText("Nenhuma coleção ainda")).toBeDefined();
	});
});
