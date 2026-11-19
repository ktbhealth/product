// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { columnCellClassName, columnValue, TableCellValue, type Column } from "./columns.tsx";

afterEach(cleanup);

describe("TableCellValue", () => {
	it("renders text and nullish fallback", () => {
		const { rerender, container } = render(<TableCellValue value="hello" />);
		expect(screen.getByText("hello")).toBeTruthy();
		rerender(<TableCellValue value={null} />);
		expect(container.textContent).toBe("—");
		rerender(<TableCellValue value={undefined} format="mono" />);
		expect(container.textContent).toBe("—");
	});

	it("stringifies objects for text format", () => {
		render(<TableCellValue value={{ a: 1 }} />);
		expect(screen.getByText('{"a":1}')).toBeTruthy();
	});

	it("applies mono styling", () => {
		const { container } = render(<TableCellValue value="abc123" format="mono" />);
		const span = container.querySelector("span");
		expect(span?.className).toContain("font-mono");
		expect(span?.className).toContain("text-muted-foreground");
		expect(screen.getByText("abc123")).toBeTruthy();
	});

	it("renders numbers right-aligned with tabular-nums", () => {
		const { container } = render(<TableCellValue value={42} format="number" />);
		const span = container.querySelector("span");
		expect(span?.className).toContain("tabular-nums");
		expect(span?.className).toContain("text-right");
		expect(screen.getByText("42")).toBeTruthy();
	});

	it("renders booleans with default and injected labels", () => {
		const { rerender } = render(<TableCellValue value={true} format="boolean" />);
		expect(screen.getByText("✓")).toBeTruthy();
		rerender(<TableCellValue value={false} format="boolean" />);
		expect(screen.getByText("—")).toBeTruthy();
		rerender(<TableCellValue value={true} format="boolean" yesLabel="Yes" noLabel="No" />);
		expect(screen.getByText("Yes")).toBeTruthy();
		rerender(<TableCellValue value={false} format="boolean" yesLabel="Yes" noLabel="No" />);
		expect(screen.getByText("No")).toBeTruthy();
		// non-boolean payload under boolean format falls back to —
		rerender(<TableCellValue value="maybe" format="boolean" />);
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("renders date and datetime through LocalDateTime", () => {
		const { rerender } = render(
			<TableCellValue value={Date.UTC(2024, 0, 15, 12)} format="date" locale="en-US" />,
		);
		expect(screen.getByText(/2024/)).toBeTruthy();
		rerender(<TableCellValue value="2024-06-01T10:30:00Z" format="datetime" locale="en-US" />);
		expect(screen.getByText(/2024/)).toBeTruthy();
	});

	it("renders fallback for non-date-like values under date formats", () => {
		const { container } = render(<TableCellValue value={{ x: 1 }} format="date" />);
		expect(container.textContent).toBe("—");
	});
});

describe("columnValue", () => {
	it("uses the explicit value extractor when present", () => {
		const column: Column<{ a: number; b: string }> = {
			key: "a",
			header: "A",
			value: (row) => row.b.length,
		};
		expect(columnValue(column, { a: 1, b: "abc" })).toBe(3);
	});

	it("falls back to a dotted-path read of key", () => {
		const column: Column<{ nested: { deep?: string } }> = {
			key: "nested.deep",
			header: "Deep",
		};
		expect(columnValue(column, { nested: { deep: "v" } })).toBe("v");
		expect(columnValue(column, { nested: {} })).toBeUndefined();
	});
});

describe("columnCellClassName", () => {
	it("returns undefined when cellClassName is absent", () => {
		const column: Column<{ a: number }> = { key: "a", header: "A" };
		expect(columnCellClassName(column, { a: 1 }, 1)).toBeUndefined();
	});

	it("returns the static string form as-is", () => {
		const column: Column<{ a: number }> = {
			key: "a",
			header: "A",
			cellClassName: "bg-warning/20",
		};
		expect(columnCellClassName(column, { a: 1 }, 1)).toBe("bg-warning/20");
	});

	it("invokes the function form with the row and resolved value", () => {
		const cellClassName = vi.fn<(row: { a: number }, value: unknown) => string | undefined>(
			(row, value) => (value === 1 ? `row-${row.a}` : undefined),
		);
		const column: Column<{ a: number }> = { key: "a", header: "A", cellClassName };
		expect(columnCellClassName(column, { a: 7 }, 1)).toBe("row-7");
		expect(cellClassName).toHaveBeenCalledWith({ a: 7 }, 1);
		expect(columnCellClassName(column, { a: 7 }, 2)).toBeUndefined();
	});
});
