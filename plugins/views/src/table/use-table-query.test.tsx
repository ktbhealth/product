// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { defaultTableRowKey, useServerTableQuery, useTableQuery } from "./use-table-query.ts";

interface Row {
	id: number;
	name: string;
	email: string;
	nested: { tag: string };
}

const ROWS: Row[] = [
	{ id: 1, name: "Ana Silva", email: "ana@x.com", nested: { tag: "vip" } },
	{ id: 2, name: "Bob Ray", email: "bob@x.com", nested: { tag: "std" } },
	{ id: 3, name: "Cid", email: "cid@y.com", nested: { tag: "vip" } },
];

const rowKey = (row: Row) => String(row.id);

describe("useTableQuery — client mode", () => {
	it("returns all rows unfiltered initially", () => {
		const { result } = renderHook(() =>
			useTableQuery({ rows: ROWS, rowKey, search: { keys: ["name"] } }),
		);
		expect(result.current.q).toBe("");
		expect(result.current.rows).toHaveLength(3);
		expect(result.current.total).toBe(3);
		expect(result.current.shown).toBe(3);
		expect(result.current.isFiltered).toBe(false);
		expect(result.current.selected.size).toBe(0);
	});

	it("filters case-insensitively over dotted keys joined with space", () => {
		const { result } = renderHook(() =>
			useTableQuery({
				rows: ROWS,
				rowKey,
				search: { keys: ["name", "nested.tag", "email"] },
			}),
		);
		act(() => result.current.setQ("VIP"));
		expect(result.current.q).toBe("VIP");
		expect(result.current.rows.map((r) => r.id)).toEqual([1, 3]);
		expect(result.current.shown).toBe(2);
		expect(result.current.total).toBe(3);
		expect(result.current.isFiltered).toBe(true);
		act(() => result.current.setQ("bob@x"));
		expect(result.current.rows.map((r) => r.id)).toEqual([2]);
		act(() => result.current.setQ("   "));
		expect(result.current.rows).toHaveLength(3);
		expect(result.current.isFiltered).toBe(false);
	});

	it("supports a predicate search receiving the normalized needle", () => {
		const predicate = vi.fn<(row: Row, needle: string) => boolean>((row, needle) =>
			row.name.toLowerCase().startsWith(needle),
		);
		const { result } = renderHook(() =>
			useTableQuery({ rows: ROWS, rowKey, search: { predicate } }),
		);
		act(() => result.current.setQ("  AN "));
		expect(result.current.rows.map((r) => r.id)).toEqual([1]);
		expect(predicate).toHaveBeenCalledWith(ROWS[0], "an");
	});

	it("treats missing search config and empty keys predictably", () => {
		const noSearch = renderHook(() => useTableQuery({ rows: ROWS, rowKey }));
		act(() => noSearch.result.current.setQ("ana"));
		expect(noSearch.result.current.rows).toHaveLength(3);
		expect(noSearch.result.current.isFiltered).toBe(false);

		const emptyKeys = renderHook(() => useTableQuery({ rows: ROWS, rowKey, search: {} }));
		act(() => emptyKeys.result.current.setQ("ana"));
		expect(emptyKeys.result.current.rows).toHaveLength(0);
	});

	it("tracks selection with toggle/clear and reports selectedRows", () => {
		const { result } = renderHook(() =>
			useTableQuery({ rows: ROWS, rowKey, search: { keys: ["name"] } }),
		);
		act(() => result.current.toggleSelection("1"));
		act(() => result.current.toggleSelection("3"));
		expect([...result.current.selected].sort()).toEqual(["1", "3"]);
		expect(result.current.selectedRows.map((r) => r.id)).toEqual([1, 3]);
		// toggling again removes
		act(() => result.current.toggleSelection("1"));
		expect(result.current.selected.has("1")).toBe(false);
		expect(result.current.selectedRows.map((r) => r.id)).toEqual([3]);
		act(() => result.current.clearSelection());
		expect(result.current.selected.size).toBe(0);
		expect(result.current.selectedRows).toHaveLength(0);
	});

	it("uses defaultTableRowKey when rowKey is omitted", () => {
		const { result } = renderHook(() => useTableQuery({ rows: ROWS, search: { keys: ["name"] } }));
		act(() => result.current.toggleSelection("2"));
		expect(result.current.selectedRows.map((r) => r.id)).toEqual([2]);
	});
});

describe("defaultTableRowKey", () => {
	it("prefers id, falls back to position, handles primitives", () => {
		expect(defaultTableRowKey({ id: 7 }, 0)).toBe("7");
		expect(defaultTableRowKey({ name: "x" }, 4)).toBe("#4");
		expect(defaultTableRowKey(null, 2)).toBe("#2");
		expect(defaultTableRowKey("plain", 1)).toBe("#1");
		expect(defaultTableRowKey({ id: null }, 3)).toBe("#3");
	});
});

describe("useServerTableQuery", () => {
	it("holds uncontrolled q/page and reports changes", () => {
		const onQuery = vi.fn<(next: { q: string; page: number; pageSize: number }) => void>();
		const { result } = renderHook(() => useServerTableQuery({ pageSize: 10, onQuery }));
		expect(result.current.q).toBe("");
		expect(result.current.page).toBe(1);
		expect(result.current.pageSize).toBe(10);
		expect(result.current.isFiltered).toBe(false);
		act(() => result.current.setPage(3));
		expect(result.current.page).toBe(3);
		expect(onQuery).toHaveBeenLastCalledWith({ q: "", page: 3, pageSize: 10 });
		act(() => result.current.setQ("ana"));
		expect(result.current.q).toBe("ana");
		// setQ resets page to 1
		expect(result.current.page).toBe(1);
		expect(onQuery).toHaveBeenLastCalledWith({ q: "ana", page: 1, pageSize: 10 });
		expect(result.current.isFiltered).toBe(true);
	});

	it("honours controlled q/page props", () => {
		const onQuery = vi.fn<(next: { q: string; page: number; pageSize: number }) => void>();
		const { result, rerender } = renderHook(
			({ q, page }: { q: string; page: number }) => useServerTableQuery({ q, page, onQuery }),
			{ initialProps: { q: "seed", page: 2 } },
		);
		expect(result.current.q).toBe("seed");
		expect(result.current.page).toBe(2);
		act(() => result.current.setQ("next"));
		// controlled: state does not move until props update
		expect(result.current.q).toBe("seed");
		expect(onQuery).toHaveBeenCalledWith({ q: "next", page: 1, pageSize: 25 });
		rerender({ q: "next", page: 1 });
		expect(result.current.q).toBe("next");
		expect(result.current.page).toBe(1);
	});
});
