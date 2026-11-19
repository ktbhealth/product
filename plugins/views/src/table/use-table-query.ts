import { useCallback, useMemo, useState } from "react";

import { getPath, viewScalarText } from "../views/view-utils.ts";

/**
 * Query-state hooks for the admin table kit.
 *
 * - {@link useTableQuery} — client-side mode: owns the search string
 *   (controlled via `query`/`onQuery` when the caller keeps `q` in
 *   URL or shared state), filters `rows` in memory (case-insensitive
 *   substring over dotted keys, or a caller predicate) and tracks
 *   row selection.
 * - {@link useServerTableQuery} — server-side mode: holds the
 *   controlled/uncontrolled `{ q, page }` pair and reports changes
 *   through `onQuery` so the page can refetch; no filtering happens
 *   here (the server already filtered `rows`).
 */

/** Default row key: the row's `id` when present, else its position —
 * pass a stable `rowKey` (e.g. `String(row.id)`) for production rows. */
export const defaultTableRowKey = <Row>(row: Row, index: number): string => {
	const id = typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined;
	return typeof id === "string" || typeof id === "number" ? String(id) : `#${index}`;
};

/** Client-mode search config: either a set of dotted row keys whose
 * scalar text is searched, or a caller predicate receiving the
 * normalized (trimmed, lowercased) needle. */
export type TableQuerySearch<Row> =
	| { readonly keys?: readonly string[] }
	| { readonly predicate: (row: Row, needle: string) => boolean };

export interface UseTableQueryOptions<Row> {
	readonly rows: readonly Row[];
	readonly rowKey?: (row: Row, index: number) => string;
	readonly search?: TableQuerySearch<Row>;
	/** Controlled search state — when `query` is provided, `q` reads
	 * from `query.q` and `setQ` reports through `onQuery` instead of
	 * updating internal state (same contract as `useServerTableQuery`). */
	readonly query?: { readonly q: string };
	/** Called on every `setQ` with the next query state. */
	readonly onQuery?: (next: { readonly q: string }) => void;
}

export interface TableQuery<Row> {
	readonly q: string;
	readonly setQ: (q: string) => void;
	/** Filtered rows — render these. */
	readonly rows: readonly Row[];
	/** Unfiltered row count. */
	readonly total: number;
	/** Filtered row count. */
	readonly shown: number;
	/** True when a non-empty needle is actively filtering. */
	readonly isFiltered: boolean;
	readonly selected: ReadonlySet<string>;
	/** Selected rows from the unfiltered `rows` input. */
	readonly selectedRows: readonly Row[];
	readonly toggleSelection: (key: string) => void;
	readonly clearSelection: () => void;
}

export function useTableQuery<Row>({
	rows,
	rowKey,
	search,
	query,
	onQuery,
}: UseTableQueryOptions<Row>): TableQuery<Row> {
	const keyOf = rowKey ?? defaultTableRowKey;
	const [qState, setQState] = useState("");
	const q = query?.q ?? qState;
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

	const needle = q.trim().toLowerCase();
	const filtered = useMemo(() => {
		if (needle === "" || search === undefined) return rows;
		if ("predicate" in search) {
			return rows.filter((row) => search.predicate(row, needle));
		}
		const keys = search.keys ?? [];
		return rows.filter((row) =>
			keys
				.map((key) => viewScalarText(getPath(row, key)))
				.join(" ")
				.toLowerCase()
				.includes(needle),
		);
	}, [rows, needle, search]);

	const selectedRows = useMemo(
		() => rows.filter((row, index) => selected.has(keyOf(row, index))),
		[rows, selected, keyOf],
	);

	const setQ = useCallback(
		(value: string) => {
			if (query === undefined) setQState(value);
			onQuery?.({ q: value });
		},
		[query, onQuery],
	);

	const toggleSelection = useCallback((key: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	const clearSelection = useCallback(() => setSelected(new Set<string>()), []);

	return {
		q,
		setQ,
		rows: filtered,
		total: rows.length,
		shown: filtered.length,
		isFiltered: search !== undefined && needle !== "",
		selected,
		selectedRows,
		toggleSelection,
		clearSelection,
	};
}

export interface UseServerTableQueryOptions {
	/** Controlled search value — when provided, `setQ` reports through
	 * `onQuery` instead of updating internal state. */
	readonly q?: string;
	/** Controlled 1-based page — same contract as `q`. */
	readonly page?: number;
	readonly pageSize?: number;
	/** Called on every `setQ`/`setPage` with the next query state.
	 * `setQ` always resets `page` to 1. */
	readonly onQuery?: (next: { q: string; page: number; pageSize: number }) => void;
}

export interface ServerTableQuery {
	readonly q: string;
	readonly setQ: (q: string) => void;
	readonly page: number;
	readonly setPage: (page: number) => void;
	readonly pageSize: number;
	readonly isFiltered: boolean;
}

/**
 * Server-side query state: holds `{ q, page }` (controlled when the
 * matching prop is supplied, internal otherwise) and forwards every
 * change to `onQuery`. Pair with `TablePage.Footer` pagination and
 * feed `rows` straight into `TablePage.Table`.
 */
export function useServerTableQuery({
	q: qProp,
	page: pageProp,
	pageSize = 25,
	onQuery,
}: UseServerTableQueryOptions = {}): ServerTableQuery {
	const [qState, setQState] = useState("");
	const [pageState, setPageState] = useState(1);
	const q = qProp ?? qState;
	const page = pageProp ?? pageState;

	const emit = useCallback(
		(nextQ: string, nextPage: number) => onQuery?.({ q: nextQ, page: nextPage, pageSize }),
		[onQuery, pageSize],
	);

	const setQ = useCallback(
		(next: string) => {
			if (qProp === undefined) {
				setQState(next);
				setPageState(1);
			}
			emit(next, 1);
		},
		[qProp, emit],
	);

	const setPage = useCallback(
		(next: number) => {
			if (pageProp === undefined) setPageState(next);
			emit(q, next);
		},
		[q, pageProp, emit],
	);

	return { q, setQ, page, setPage, pageSize, isFiltered: q.trim() !== "" };
}
