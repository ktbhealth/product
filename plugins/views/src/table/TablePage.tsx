import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";

import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import { DataToolbar, type DataToolbarResultCount } from "@ktbhealth/ui/components/data-toolbar";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import { viewsMessages, type ViewMessages } from "../i18n.ts";
import { columnValue, TableCellValue, type Column } from "./columns.tsx";
import { defaultTableRowKey } from "./use-table-query.ts";

/**
 * Compound shell for admin list pages — the shared replacement for
 * the `PageContainer` + `PageHeader` + `DataToolbar` + `Table` +
 * `Empty` + pagination boilerplate repeated across `Admin*Page`
 * views.
 *
 * ```tsx
 * <TablePage messages={t}>
 *   <TablePage.Header title={t.title} description={t.count(rows.length)} actions={…} />
 *   <TablePage.Toolbar search={<SearchInput …/>} resultCount={…} />
 *   <TablePage.Table columns={cols} rows={rows} rowKey={(r) => String(r.id)} />
 *   <TablePage.Footer>…pagination…</TablePage.Footer>
 * </TablePage>
 * ```
 *
 * `messages` accepts any `ViewMessages` (or the table-kit subset) and
 * localizes the selection aria-labels, the filtered-empty row and the
 * default empty state; without it the English catalog is used.
 */

export type TablePageMessages = Pick<
	ViewMessages,
	"tableSelectAll" | "tableSelectRow" | "tableNoMatch" | "emptyTitle" | "emptyDescription"
>;

const TableMessagesContext = createContext<TablePageMessages | null>(null);

const useTableMessages = (): TablePageMessages =>
	useContext(TableMessagesContext) ?? viewsMessages("en");

const ALIGN_CLS = {
	left: "text-left",
	center: "text-center",
	right: "text-right",
} as const;

const joinCls = (...parts: readonly (string | undefined)[]): string | undefined => {
	const cls = parts.filter(Boolean).join(" ");
	return cls === ""
		? /* v8 ignore next -- every call site passes a non-empty literal first */ undefined
		: cls;
};

export interface TablePageProps {
	readonly children: ReactNode;
	readonly className?: string;
	readonly messages?: TablePageMessages;
}

function TablePageRoot({ children, className, messages }: TablePageProps) {
	return (
		<TableMessagesContext.Provider value={messages ?? null}>
			<PageContainer className={className}>
				<div className="flex flex-col gap-4">{children}</div>
			</PageContainer>
		</TableMessagesContext.Provider>
	);
}

export interface TablePageHeaderProps {
	readonly title: ReactNode;
	readonly description?: ReactNode;
	readonly actions?: ReactNode;
}

function TablePageHeader({ title, description, actions }: TablePageHeaderProps) {
	// `PageHeaderProps` intersects `ComponentProps<"div">`, whose `title`
	// HTML attribute is `string` — the effective prop type rejects
	// non-string ReactNode even though the component renders it fine.
	// Cast at the boundary; our prop stays ReactNode per the kit API.
	return (
		<PageHeader
			title={title as ComponentProps<typeof PageHeader>["title"]}
			description={description}
			actions={actions}
		/>
	);
}

export interface TablePageToolbarProps {
	readonly search?: ReactNode;
	readonly filters?: ReactNode;
	readonly actions?: ReactNode;
	readonly resultCount?: ReactNode | DataToolbarResultCount;
	readonly className?: string;
}

function TablePageToolbar({
	search,
	filters,
	actions,
	resultCount,
	className,
}: TablePageToolbarProps) {
	return (
		<DataToolbar
			search={search}
			filters={filters}
			actions={actions}
			resultCount={resultCount}
			className={className}
		/>
	);
}

export interface TablePageTableEmpty {
	readonly title: ReactNode;
	readonly description?: ReactNode;
}

export interface TablePageTableProps<Row> {
	readonly columns: readonly Column<Row>[];
	readonly rows: readonly Row[];
	/** Stable row identifier — drives `key`, selection state and the
	 * selection aria-labels. Defaults to `row.id` ?? index. */
	readonly rowKey?: (row: Row, index: number) => string;
	/** Unfiltered total — distinguishes the true empty state from a
	 * filtered-empty result when `rows` is empty. Defaults to
	 * `rows.length`. */
	readonly total?: number;
	/** True-empty copy; defaults to the catalog's `emptyTitle`/
	 * `emptyDescription`. */
	readonly empty?: TablePageTableEmpty;
	/** Filtered-empty content (shown when `rows` is empty but `total`
	 * says records exist, or `isFiltered` is set). Defaults to the
	 * catalog's `tableNoMatch`. */
	readonly noMatch?: ReactNode;
	readonly isFiltered?: boolean;
	readonly loading?: boolean;
	/** Trailing actions cell per row (buttons, menus). */
	readonly rowActions?: (row: Row) => ReactNode;
	readonly selectable?: boolean;
	/** Controlled selection — omit for internal state. */
	readonly selected?: ReadonlySet<string>;
	readonly onSelectionChange?: (keys: ReadonlySet<string>) => void;
	/** BCP-47 locale forwarded to date/datetime cells. */
	readonly locale?: string;
	readonly className?: string;
}

function TablePageTableInner<Row>({
	columns,
	rows,
	rowKey,
	total,
	empty,
	noMatch,
	isFiltered,
	loading = false,
	rowActions,
	selectable = false,
	selected,
	onSelectionChange,
	locale,
	className,
}: TablePageTableProps<Row>) {
	const messages = useTableMessages();
	const keyOf = rowKey ?? defaultTableRowKey;
	const [innerSelected, setInnerSelected] = useState<ReadonlySet<string>>(() => new Set());
	const selectedSet = selected ?? innerSelected;

	const emitSelection = (next: ReadonlySet<string>) => {
		if (selected === undefined) setInnerSelected(next);
		onSelectionChange?.(next);
	};

	const toggleRow = (key: string) => {
		const next = new Set(selectedSet);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		emitSelection(next);
	};

	const rowKeys = rows.map((row, index) => keyOf(row, index));
	const allSelected = rowKeys.length > 0 && rowKeys.every((key) => selectedSet.has(key));
	const someSelected = !allSelected && rowKeys.some((key) => selectedSet.has(key));
	const toggleAll = () => {
		emitSelection(allSelected ? new Set<string>() : new Set(rowKeys));
	};

	const colCount = columns.length + (selectable ? 1 : 0) + (rowActions !== undefined ? 1 : 0);
	// Filtered-empty: no rows but the unfiltered total (or an active
	// filter) says records exist — show `noMatch` instead of `empty`.
	const filteredEmpty = rows.length === 0 && (isFiltered === true || (total ?? rows.length) > 0);

	if (!loading && rows.length === 0 && !filteredEmpty) {
		const description = empty === undefined ? messages.emptyDescription : empty.description;
		return (
			<Empty className={joinCls("border", className)}>
				<EmptyHeader>
					<EmptyTitle>{empty?.title ?? messages.emptyTitle}</EmptyTitle>
					{description !== undefined && description !== null ? (
						<EmptyDescription>{description}</EmptyDescription>
					) : null}
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className={joinCls("overflow-x-auto rounded-lg border border-border", className)}>
			<Table>
				<TableHeader>
					<TableRow>
						{selectable ? (
							<TableHead className="w-10">
								<Checkbox
									checked={allSelected}
									indeterminate={someSelected}
									onCheckedChange={toggleAll}
									aria-label={messages.tableSelectAll}
								/>
							</TableHead>
						) : null}
						{columns.map((column) => (
							<TableHead
								key={column.key}
								style={column.width === undefined ? undefined : { width: column.width }}
								className={column.align === undefined ? undefined : ALIGN_CLS[column.align]}
							>
								{column.header}
							</TableHead>
						))}
						{rowActions !== undefined ? <TableHead /> : null}
					</TableRow>
				</TableHeader>
				<TableBody>
					{loading ? (
						<TableRow>
							<TableCell colSpan={colCount} className="py-8 text-center">
								<Spinner className="mx-auto" />
							</TableCell>
						</TableRow>
					) : rows.length === 0 ? (
						<TableRow>
							<TableCell
								colSpan={colCount}
								className="py-8 text-center text-sm text-muted-foreground"
							>
								{noMatch ?? messages.tableNoMatch}
							</TableCell>
						</TableRow>
					) : (
						rows.map((row, index) => {
							/* v8 ignore next -- rowKeys is mapped from the same rows, so the
							   ?? fallback can never produce a different key */
							const key = rowKeys[index] ?? keyOf(row, index);
							return (
								<TableRow key={key}>
									{selectable ? (
										<TableCell>
											<Checkbox
												checked={selectedSet.has(key)}
												onCheckedChange={() => toggleRow(key)}
												aria-label={`${messages.tableSelectRow} ${key}`}
											/>
										</TableCell>
									) : null}
									{columns.map((column) => {
										const value = columnValue(column, row);
										return (
											<TableCell
												key={column.key}
												className={joinCls(
													"text-sm",
													column.align === undefined ? undefined : ALIGN_CLS[column.align],
												)}
											>
												{column.render !== undefined ? (
													column.render(row, value)
												) : (
													<TableCellValue value={value} format={column.format} locale={locale} />
												)}
											</TableCell>
										);
									})}
									{rowActions !== undefined ? (
										<TableCell className="text-right">{rowActions(row)}</TableCell>
									) : null}
								</TableRow>
							);
						})
					)}
				</TableBody>
			</Table>
		</div>
	);
}

export interface TablePageFooterProps {
	readonly children: ReactNode;
	readonly className?: string;
}

function TablePageFooter({ children, className }: TablePageFooterProps) {
	return (
		<div className={joinCls("flex items-center justify-between gap-4", className)}>{children}</div>
	);
}

export const TablePage = Object.assign(TablePageRoot, {
	Header: TablePageHeader,
	Toolbar: TablePageToolbar,
	Table: TablePageTableInner,
	Footer: TablePageFooter,
});

export { TablePageHeader, TablePageToolbar, TablePageTableInner, TablePageFooter };
