import type { ReactNode } from "react";

import type { PageI18nSlice } from "@ktb/kernel";

import type { Column } from "./columns.tsx";
import type { FormField } from "./FormDialog.tsx";

/**
 * Declarative admin-table definition consumed by
 * `adminTablePage` (`admin-table-page.tsx`). A plugin describes its
 * list once — copy, columns, search, actions, create dialog — and the
 * kit renders the `TablePage` shell, client-side query state,
 * selection/bulk bar, confirm dialogs and mutation plumbing.
 *
 * Copy fields accept either a static `ReactNode` or a function
 * `(t) => ReactNode` resolved against the plugin's message catalog
 * (`def.i18n.messages(locale)` merged with the DB slice via
 * `sliceMessages`). Function-valued messages must invoke parametrized
 * catalog entries themselves, e.g. `(t) => t.count(rows.length)`.
 */

/** Static copy or a `t`-resolved factory. */
export type AdminTableText<M extends object = Record<string, unknown>> =
	| ReactNode
	| ((t: M) => ReactNode);

/** Column descriptor — {@link Column} with `t`-aware header/render. */
export interface AdminTableColumn<Row, M extends object = Record<string, unknown>> extends Omit<
	Column<Row>,
	"header" | "render"
> {
	readonly header: AdminTableText<M>;
	/** Escape hatch — wins over `format`; receives the resolved `t`. */
	readonly render?: (t: M, row: Row, value: unknown) => ReactNode;
}

/** Confirm-dialog copy for destructive/confirmable actions. */
export interface AdminTableActionConfirm<M extends object = Record<string, unknown>> {
	readonly title: AdminTableText<M>;
	readonly description?: AdminTableText<M>;
	readonly confirmLabel?: AdminTableText<M>;
	readonly cancelLabel?: AdminTableText<M>;
	readonly variant?: "default" | "destructive";
}

/** Mutation contract shared by row/bulk/create actions: resolves a
 * server-fn-style envelope (`{ ok: true, … }` / `{ ok: false }`) or a
 * bare `true`/`false`. Anything else is treated as failure. */
export type AdminTableRunResult = Promise<unknown>;

export interface AdminTableRowAction<Row, M extends object = Record<string, unknown>> {
	readonly id: string;
	readonly label: AdminTableText<M>;
	/** Per-row visibility — returning false hides the action. */
	readonly hidden?: (row: Row) => boolean;
	readonly disabled?: (row: Row) => boolean;
	/** When present the action runs behind a ConfirmDialog. */
	readonly confirm?: AdminTableActionConfirm<M>;
	readonly run: (row: Row) => AdminTableRunResult;
}

export interface AdminTableBulkAction<Row, M extends object = Record<string, unknown>> {
	readonly id: string;
	readonly label: AdminTableText<M>;
	readonly confirm?: AdminTableActionConfirm<M>;
	/** Receives the currently selected rows (unfiltered input order). */
	readonly run: (rows: readonly Row[]) => AdminTableRunResult;
}

/** Create dialog — renders a header button + FormDialog. */
export interface AdminTableCreate<M extends object = Record<string, unknown>> {
	readonly label: AdminTableText<M>;
	readonly title?: AdminTableText<M>;
	readonly description?: AdminTableText<M>;
	readonly fields: readonly FormField[] | ((t: M) => readonly FormField[]);
	readonly submitLabel?: AdminTableText<M>;
	readonly cancelLabel?: AdminTableText<M>;
	/** Receives trimmed field values; success closes the dialog and
	 * invalidates the router. */
	readonly onSubmit: (values: Record<string, string>) => AdminTableRunResult;
}

/** Client-side search config — `keys`/`predicate` feed
 * `useTableQuery`; `placeholder`/`label` localize the input. */
export interface AdminTableSearch<Row, M extends object = Record<string, unknown>> {
	readonly keys?: readonly string[];
	readonly predicate?: (row: Row, needle: string) => boolean;
	readonly placeholder?: AdminTableText<M>;
	readonly label?: AdminTableText<M>;
}

export interface AdminTableEmpty<M extends object = Record<string, unknown>> {
	readonly title?: AdminTableText<M>;
	readonly description?: AdminTableText<M>;
}

export interface AdminTableI18n<M extends object> {
	/** DB catalog namespace for `sliceMessages` overrides. */
	readonly namespace: string;
	/** Locale → typed message catalog (e.g. `userMessages`). */
	readonly messages: (locale: string) => M;
}

export interface AdminTableDef<Row, M extends object = Record<string, unknown>> {
	/** Stable identifier — used for the component displayName and
	 * diagnostics. Must be non-empty. */
	readonly id: string;
	readonly i18n: AdminTableI18n<M>;
	readonly title: AdminTableText<M>;
	readonly description?: AdminTableText<M>;
	readonly search?: AdminTableSearch<Row, M>;
	readonly columns: readonly AdminTableColumn<Row, M>[];
	/** Stable row id — defaults to the row's `id` ?? index. */
	readonly rowKey?: (row: Row, index: number) => string;
	readonly empty?: AdminTableEmpty<M>;
	readonly noMatch?: AdminTableText<M>;
	/** Extra nodes rendered in the page header's actions slot. */
	readonly headerActions?: AdminTableText<M>;
	readonly rowActions?: readonly AdminTableRowAction<Row, M>[];
	readonly bulkActions?: readonly AdminTableBulkAction<Row, M>[];
	readonly create?: AdminTableCreate<M>;
	/** Escape slot rendered between the table and the footer area. */
	readonly extensions?: AdminTableText<M>;
	/** Kit-chrome copy overrides (English defaults otherwise). */
	readonly selectedCount?: (t: M, selected: number, total: number) => ReactNode;
	readonly clearSelection?: AdminTableText<M>;
	readonly actionError?: AdminTableText<M>;
}

const assert = (condition: boolean, message: string): void => {
	if (!condition) throw new Error(`defineAdminTable: ${message}`);
};

const uniqueIds = (ids: readonly string[], what: string): void => {
	const seen = new Set<string>();
	for (const id of ids) {
		assert(!seen.has(id), `duplicate ${what} "${id}"`);
		seen.add(id);
	}
};

/**
 * Identity factory with runtime validation — returns the definition
 * unchanged after checking the invariants `adminTablePage` relies on:
 * non-empty `id`, non-empty `columns`, unique column keys and unique
 * row/bulk action ids.
 */
export const defineAdminTable = <Row, M extends object = Record<string, unknown>>(
	def: AdminTableDef<Row, M>,
): AdminTableDef<Row, M> => {
	assert(typeof def.id === "string" && def.id.trim() !== "", "id must be a non-empty string");
	assert(Array.isArray(def.columns) && def.columns.length > 0, "columns must be non-empty");
	uniqueIds(
		def.columns.map((column) => column.key),
		"column key",
	);
	uniqueIds(
		(def.rowActions ?? []).map((action) => action.id),
		"row action",
	);
	uniqueIds(
		(def.bulkActions ?? []).map((action) => action.id),
		"bulk action",
	);
	return def;
};

/** Props accepted by the component returned from `adminTablePage`. */
export interface AdminTablePageProps<Row> {
	readonly rows: readonly Row[];
	/** Active UI locale, injected by the host via the panel page ctx. */
	readonly locale?: string;
	/** DB catalog slice for this route's namespaces (PL-008). */
	readonly i18n?: PageI18nSlice;
	readonly loading?: boolean;
}
