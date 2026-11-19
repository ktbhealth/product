import type { ReactNode } from "react";

import { LocalDateTime } from "../views/LocalDateTime.tsx";
import { getPath, viewScalarText } from "../views/view-utils.ts";

/**
 * Column model + default cell renderer for the admin table kit
 * (`TablePage.Table`). A column declares how its value is read
 * (`value`, defaulting to a dotted-path read of `key` off the row),
 * how it is aligned, and how the raw value formats — or escapes
 * formatting entirely with a custom `render`.
 */

export type TableColumnFormat = "text" | "mono" | "date" | "datetime" | "number" | "boolean";

export interface Column<Row> {
	/** Row property/path the cell reads when `value` is absent —
	 * dotted paths (`"patient.name"`) resolve through `getPath`. */
	readonly key: string;
	readonly header: ReactNode;
	/** CSS width applied to the header cell (`"12rem"`, `"10%"`, …). */
	readonly width?: string | number;
	readonly align?: "left" | "center" | "right";
	readonly format?: TableColumnFormat;
	/** Custom value extractor; defaults to `getPath(row, key)`. */
	readonly value?: (row: Row) => unknown;
	/** Escape hatch — wins over `format` when present. */
	readonly render?: (row: Row, value: unknown) => ReactNode;
	/** Per-cell class hook merged onto the `TableCell` after the
	 * default `text-sm`/alignment classes. A string applies to every
	 * row; the function form resolves per row (and receives the
	 * resolved value) for cases like heatmap tints. */
	readonly cellClassName?: string | ((row: Row, value: unknown) => string | undefined);
}

/** Alias matching the `TablePage.Table` prop name. */
export type TableColumn<Row> = Column<Row>;

export interface TableCellValueProps {
	readonly value: unknown;
	readonly format?: TableColumnFormat;
	/** BCP-47 locale forwarded to date/datetime cells. */
	readonly locale?: string;
	/** `boolean` format labels — default to the `✓`/`—` glyphs. */
	readonly yesLabel?: ReactNode;
	readonly noLabel?: ReactNode;
}

const isDateLike = (value: unknown): value is Date | number | string =>
	value instanceof Date || typeof value === "number" || typeof value === "string";

/**
 * Default cell renderer implementing the {@link TableColumnFormat}
 * union. Nullish values render `—` for every format; `render` on the
 * column bypasses this component entirely.
 */
export function TableCellValue({
	value,
	format = "text",
	locale,
	yesLabel,
	noLabel,
}: TableCellValueProps): ReactNode {
	if (value === undefined || value === null) return "—";
	switch (format) {
		case "mono":
			return (
				<span className="font-mono text-xs text-muted-foreground">{viewScalarText(value)}</span>
			);
		case "date":
		case "datetime":
			return (
				<LocalDateTime
					value={isDateLike(value) ? value : null}
					locale={locale}
					fallback="—"
					options={format === "date" ? { dateStyle: "medium" } : undefined}
				/>
			);
		case "number":
			return <span className="block text-right tabular-nums">{viewScalarText(value)}</span>;
		case "boolean":
			return value === true ? (yesLabel ?? "✓") : value === false ? (noLabel ?? "—") : "—";
		default:
			return viewScalarText(value);
	}
}

/** Resolve a column's display value for a row: explicit `value`
 * extractor wins, else a dotted-path read of `key`. */
export const columnValue = <Row,>(column: Column<Row>, row: Row): unknown =>
	column.value !== undefined ? column.value(row) : getPath(row, column.key);

/** Resolve a column's per-cell class for a row: the string form
 * applies as-is, the function form is invoked with the row and its
 * resolved value. */
export const columnCellClassName = <Row,>(
	column: Column<Row>,
	row: Row,
	value: unknown,
): string | undefined =>
	typeof column.cellClassName === "function"
		? column.cellClassName(row, value)
		: column.cellClassName;
