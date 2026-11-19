import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import { columnValue, TableCellValue, type Column } from "./columns.tsx";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { defaultTableRowKey } from "./use-table-query.ts";

/**
 * Scrollable collection-inside-a-dialog — the generalized form of the
 * `TenantMembersDialog` pattern (members list + add form + per-row
 * remove with confirm). The dialog owns loading/busy/error state;
 * callers supply a `load` source, optional `remove` mutation and an
 * `addForm` render prop that receives `{ reload, busy, error }`.
 */

/** `load` may resolve a server-fn envelope, a bare row array, or a
 * `{ ok: false }` failure — all are normalized internally. */
export type CollectionLoadResult<Row> =
	| { readonly ok: true; readonly data: readonly Row[] }
	| { readonly ok: false }
	| readonly Row[];

export interface CollectionDialogMessages {
	readonly loading: ReactNode;
	readonly empty: ReactNode;
	readonly error: ReactNode;
	readonly remove: ReactNode;
	readonly removeTitle: ReactNode;
	readonly removeConfirm: ReactNode;
	readonly cancel: ReactNode;
}

const DEFAULT_MESSAGES: CollectionDialogMessages = {
	loading: "Loading…",
	empty: "Nothing here yet.",
	error: "Something went wrong. Try again.",
	remove: "Remove",
	removeTitle: "Remove item?",
	removeConfirm: "Remove",
	cancel: "Cancel",
};

/** Context handed to the `addForm` render prop. */
export interface CollectionDialogAddContext {
	/** Re-runs `load` — call after a successful add. */
	readonly reload: () => Promise<void>;
	readonly busy: boolean;
	readonly error: boolean;
}

export interface CollectionDialogProps<Row> {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly title: ReactNode;
	readonly description?: ReactNode;
	/** Columns rendered through the shared cell pipeline. */
	readonly columns: readonly Column<Row>[];
	readonly rowKey?: (row: Row, index: number) => string;
	/** BCP-47 locale forwarded to date/datetime cells. */
	readonly locale?: string;
	/** Load the collection — called on open and on every `reload()`. */
	readonly load: () => Promise<CollectionLoadResult<Row>>;
	/** Per-row remove mutation; omit to hide the actions column. */
	readonly remove?: (row: Row) => Promise<unknown>;
	/** Add-form render prop — receives `{ reload, busy, error }`. */
	readonly addForm?: (ctx: CollectionDialogAddContext) => ReactNode;
	/** Partial copy overrides merged over the English defaults. */
	readonly messages?: Partial<CollectionDialogMessages>;
	readonly className?: string;
}

const isOkResult = (res: unknown): boolean =>
	res === true ||
	(res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === true);

const normalizeLoad = <Row,>(res: CollectionLoadResult<Row>): { ok: boolean; rows: Row[] } => {
	if (Array.isArray(res)) return { ok: true, rows: [...res] };
	if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === true) {
		const data = (res as { data?: unknown }).data;
		return { ok: true, rows: Array.isArray(data) ? [...(data as Row[])] : [] };
	}
	return { ok: false, rows: [] };
};

export function CollectionDialog<Row>({
	open,
	onOpenChange,
	title,
	description,
	columns,
	rowKey,
	locale,
	load,
	remove,
	addForm,
	messages,
	className,
}: CollectionDialogProps<Row>) {
	const m = { ...DEFAULT_MESSAGES, ...messages };
	const keyOf = rowKey ?? defaultTableRowKey;
	const [rows, setRows] = useState<readonly Row[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);

	// Latest `load` without re-subscribing the open effect — the ref is
	// synced in an effect, never during render.
	const loadRef = useRef(load);
	useEffect(() => {
		loadRef.current = load;
	});

	const reload = useCallback(async () => {
		try {
			const norm = normalizeLoad(await loadRef.current());
			if (norm.ok) {
				setRows(norm.rows);
				setError(false);
			} else {
				setRows((prev) => prev ?? []);
				setError(true);
			}
		} catch {
			setRows((prev) => prev ?? []);
			setError(true);
		}
	}, []);

	useEffect(() => {
		// Reopen keeps the previous rows visible while `reload` refreshes
		// them — avoids a synchronous setState cascade in the effect.
		if (open) void reload();
	}, [open, reload]);

	const removeRow = async (row: Row) => {
		/* v8 ignore next -- removeRow only runs from the row confirm action,
		   which only renders while `remove` is defined */
		if (remove === undefined) return;
		setBusy(true);
		setError(false);
		try {
			const res = await remove(row);
			if (isOkResult(res)) {
				await reload();
			} else {
				setError(true);
			}
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};

	const addContext: CollectionDialogAddContext = { reload, busy, error };

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className={className ?? "max-w-lg"}>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description ? <DialogDescription>{description}</DialogDescription> : null}
				</DialogHeader>
				{error ? <p className="text-xs text-destructive">{m.error}</p> : null}
				{rows === null ? (
					<div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
						<Spinner />
						{m.loading}
					</div>
				) : rows.length === 0 ? (
					<p className="py-4 text-center text-xs text-muted-foreground">{m.empty}</p>
				) : (
					<div className="max-h-64 overflow-y-auto rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									{columns.map((column) => (
										<TableHead
											key={column.key}
											style={column.width === undefined ? undefined : { width: column.width }}
										>
											{column.header}
										</TableHead>
									))}
									{remove !== undefined ? <TableHead className="w-10" /> : null}
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row, index) => {
									const key = keyOf(row, index);
									return (
										<TableRow key={key}>
											{columns.map((column) => {
												const value = columnValue(column, row);
												return (
													<TableCell key={column.key} className="text-sm">
														{column.render !== undefined ? (
															column.render(row, value)
														) : (
															<TableCellValue
																value={value}
																format={column.format}
																locale={locale}
															/>
														)}
													</TableCell>
												);
											})}
											{remove !== undefined ? (
												<TableCell className="text-right">
													<ConfirmAction
														trigger={
															<Button type="button" variant="ghost" size="sm" disabled={busy}>
																{m.remove}
															</Button>
														}
														title={m.removeTitle}
														confirmLabel={m.removeConfirm}
														cancelLabel={m.cancel}
														variant="destructive"
														onConfirm={() => removeRow(row)}
													/>
												</TableCell>
											) : null}
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>
				)}
				{addForm?.(addContext)}
			</DialogContent>
		</Dialog>
	);
}
