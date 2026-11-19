// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Column } from "./columns.tsx";
import { SearchInput } from "./SearchInput.tsx";
import { TablePage, type TablePageTableProps } from "./TablePage.tsx";

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	role: string;
	active: boolean;
}

const ROWS: Row[] = [
	{ id: 1, name: "Ana", role: "admin", active: true },
	{ id: 2, name: "Bob", role: "user", active: false },
];

const COLUMNS: Column<Row>[] = [
	{ key: "name", header: "Name", format: "text" },
	{ key: "role", header: "Role", format: "mono" },
	{ key: "active", header: "Active", format: "boolean" },
];

const customMessages = {
	tableSelectAll: "Seleccionar todo",
	tableSelectRow: "Seleccionar fila",
	tableNoMatch: "Sin coincidencias",
	emptyTitle: "Vacío",
	emptyDescription: "Nada que mostrar",
};

const renderPage = (tableProps: Partial<TablePageTableProps<Row>> = {}) =>
	render(
		<TablePage messages={customMessages}>
			<TablePage.Header
				title="Users"
				description="All users"
				actions={<button type="button">New</button>}
			/>
			<TablePage.Toolbar
				search={<SearchInput value="" onChange={() => {}} placeholder="Search" />}
				resultCount={{ shown: 2, total: 9 }}
			/>
			<TablePage.Table
				columns={COLUMNS}
				rows={ROWS}
				rowKey={(row) => String(row.id)}
				{...tableProps}
			/>
			<TablePage.Footer>
				<span>Page 1 of 3</span>
			</TablePage.Footer>
		</TablePage>,
	);

describe("TablePage", () => {
	it("renders header, toolbar, table and footer slots", () => {
		renderPage();
		expect(screen.getByText("Users")).toBeTruthy();
		expect(screen.getByText("All users")).toBeTruthy();
		expect(screen.getByRole("button", { name: "New" })).toBeTruthy();
		expect(screen.getByPlaceholderText("Search")).toBeTruthy();
		expect(screen.getByText("Showing 2 of 9")).toBeTruthy();
		expect(screen.getByText("Name")).toBeTruthy();
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("Bob")).toBeTruthy();
		expect(screen.getByText("Page 1 of 3")).toBeTruthy();
	});

	it("renders the true empty state with catalog defaults", () => {
		render(
			<TablePage>
				<TablePage.Table columns={COLUMNS} rows={[]} rowKey={(r) => String(r.id)} />
			</TablePage>,
		);
		expect(screen.getByText("No records")).toBeTruthy();
		expect(screen.getByText("No records match this view.")).toBeTruthy();
	});

	it("honours custom empty copy", () => {
		renderPage({ rows: [], total: 0 });
		expect(screen.getByText("Vacío")).toBeTruthy();
	});

	it("shows noMatch (not empty) when rows is empty but total > 0", () => {
		renderPage({ rows: [], total: 5, isFiltered: true });
		expect(screen.getByText("Sin coincidencias")).toBeTruthy();
		expect(screen.queryByText("Vacío")).toBeNull();
		// column headers stay visible
		expect(screen.getByText("Name")).toBeTruthy();
	});

	it("falls back to the catalog tableNoMatch", () => {
		renderPage({ rows: [], total: 5 });
		expect(screen.getByText("Sin coincidencias")).toBeTruthy();
	});

	it("renders a loading row instead of data", () => {
		renderPage({ loading: true });
		expect(screen.getByRole("status")).toBeTruthy();
		expect(screen.queryByText("Ana")).toBeNull();
	});

	it("renders rowActions in a trailing column", () => {
		renderPage({ rowActions: (row) => <button type="button">Edit {row.name}</button> });
		expect(screen.getByRole("button", { name: "Edit Ana" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Edit Bob" })).toBeTruthy();
	});

	it("column render escapes the format pipeline", () => {
		const columns: Column<Row>[] = [
			{
				key: "active",
				header: "Active",
				format: "boolean",
				render: (row) => <em>custom-{row.id}</em>,
			},
		];
		render(
			<TablePage>
				<TablePage.Table columns={columns} rows={ROWS} rowKey={(r) => String(r.id)} />
			</TablePage>,
		);
		expect(screen.getByText("custom-1")).toBeTruthy();
		expect(screen.queryByText("✓")).toBeNull();
	});

	it("supports selection with internal state and onSelectionChange", () => {
		const onSelectionChange = vi.fn<(keys: ReadonlySet<string>) => void>();
		renderPage({ selectable: true, onSelectionChange });
		const boxes = screen.getAllByRole("checkbox");
		// header select-all + one per row
		expect(boxes.length).toBe(3);
		expect(screen.getByLabelText("Seleccionar todo")).toBeTruthy();
		expect(screen.getByLabelText("Seleccionar fila 1")).toBeTruthy();
		fireEvent.click(screen.getByLabelText("Seleccionar fila 1"));
		expect(onSelectionChange).toHaveBeenCalledWith(new Set(["1"]));
		// select-all picks up every row
		fireEvent.click(screen.getByLabelText("Seleccionar todo"));
		expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(["1", "2"]));
	});

	it("supports controlled selection", () => {
		const selected = new Set(["2"]);
		renderPage({ selectable: true, selected });
		const rowBox = screen.getByLabelText("Seleccionar fila 2");
		expect(rowBox.getAttribute("aria-checked")).toBe("true");
	});

	it("applies column alignment classes", () => {
		const columns: Column<Row>[] = [
			{ key: "name", header: "Name", align: "center" },
			{ key: "role", header: "Role", align: "right" },
		];
		const { container } = render(
			<TablePage>
				<TablePage.Table columns={columns} rows={ROWS} rowKey={(r) => String(r.id)} />
			</TablePage>,
		);
		expect(container.querySelectorAll(".text-center").length).toBeGreaterThan(0);
		expect(container.querySelectorAll(".text-right").length).toBeGreaterThan(0);
	});
});
