import { useRouter } from "@tanstack/react-router";
import { useMemo, useState, type ComponentType, type ReactNode } from "react";

import { sliceMessages } from "@ktb/i18n";

import { Button } from "@ktbhealth/ui/components/button";

import { viewsMessages } from "../i18n.ts";
import type { Column } from "./columns.tsx";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { FormDialog } from "./FormDialog.tsx";
import { SearchInput } from "./SearchInput.tsx";
import { TablePage } from "./TablePage.tsx";
import { defaultTableRowKey, useTableQuery } from "./use-table-query.ts";
import type {
	AdminTableActionConfirm,
	AdminTableBulkAction,
	AdminTableDef,
	AdminTablePageProps,
	AdminTableRowAction,
	AdminTableText,
} from "./define-admin-table.ts";

export { defineAdminTable } from "./define-admin-table.ts";
export type {
	AdminTableBulkAction,
	AdminTableColumn,
	AdminTableCreate,
	AdminTableDef,
	AdminTableEmpty,
	AdminTableI18n,
	AdminTablePageProps,
	AdminTableRowAction,
	AdminTableSearch,
	AdminTableText,
} from "./define-admin-table.ts";

/**
 * `adminTablePage(def)` turns an `AdminTableDef` into a ready
 * `ComponentType<AdminTablePageProps<Row>>` — the shared replacement
 * for the per-plugin `Admin*Page` boilerplate (PageContainer +
 * PageHeader + DataToolbar + Table + Empty + busy/error/invalidate
 * plumbing).
 *
 * The generated component resolves `t` via
 * `sliceMessages(i18n, def.i18n.namespace, def.i18n.messages(locale))`,
 * runs client-side `useTableQuery`, wires selection to the bulk bar,
 * routes every action through a single error line plus
 * `router.invalidate()` on success, and renders `def.extensions` as an
 * escape slot. Wrap the def in `defineAdminTable` for runtime
 * validation (non-empty id/columns, unique keys/ids).
 */

const isOkResult = (res: unknown): boolean =>
	res === true ||
	(res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === true);

const resolveText = <M extends object>(value: AdminTableText<M> | undefined, t: M): ReactNode =>
	value === undefined ? undefined : typeof value === "function" ? value(t) : value;

const KIT_DEFAULTS = {
	selectedCount: (_t: object, n: number) => `${n} selected`,
	clearSelection: "Clear",
	actionError: "Action failed. Try again.",
} as const;

/** Confirm-dialog props shared by row/bulk actions, resolved against `t`. */
const confirmProps = <M extends object>(confirm: AdminTableActionConfirm<M>, t: M) => ({
	title: resolveText(confirm.title, t),
	description: resolveText(confirm.description, t),
	confirmLabel: resolveText(confirm.confirmLabel ?? "Confirm", t),
	cancelLabel: resolveText(confirm.cancelLabel ?? "Cancel", t),
	variant: confirm.variant,
});

export function adminTablePage<Row, M extends object>(
	def: AdminTableDef<Row, M>,
): ComponentType<AdminTablePageProps<Row>> {
	const rowActions = def.rowActions ?? [];
	const bulkActions = def.bulkActions ?? [];
	const hasRowActions = rowActions.length > 0;
	const hasBulkActions = bulkActions.length > 0;
	const createDef = def.create;

	const toColumn = (column: AdminTableDef<Row, M>["columns"][number], t: M): Column<Row> => ({
		key: column.key,
		header: resolveText(column.header, t),
		width: column.width,
		align: column.align,
		format: column.format,
		value: column.value,
		render:
			column.render === undefined ? undefined : (row, value) => column.render?.(t, row, value),
	});

	const AdminTablePage = ({
		rows,
		locale = "en",
		i18n,
		loading = false,
	}: AdminTablePageProps<Row>) => {
		const t = sliceMessages(i18n, def.i18n.namespace, def.i18n.messages(locale));
		const kitT = viewsMessages(locale);
		const router = useRouter();
		const baseKeyOf = def.rowKey ?? defaultTableRowKey;

		// Selection/action keys must be stable across client-side
		// filtering — `TablePage.Table` sees filtered indices, so key
		// rows by their position in the unfiltered input.
		const indexByRow = useMemo(
			() => new Map(rows.map((row, index) => [row, index] as const)),
			[rows],
		);
		const keyOf = useMemo(
			() =>
				(row: Row, index: number): string =>
					baseKeyOf(
						row,
						/* v8 ignore next -- keyOf only receives rows drawn from `rows`,
						   which is what built indexByRow, so the ?? fallback is dead */
						indexByRow.get(row) ?? index,
					),
			[baseKeyOf, indexByRow],
		);

		const search =
			def.search?.predicate !== undefined
				? { predicate: def.search.predicate }
				: def.search?.keys !== undefined
					? { keys: def.search.keys }
					: undefined;

		const query = useTableQuery<Row>({ rows, rowKey: keyOf, search });

		const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
		const [pendingId, setPendingId] = useState<string | null>(null);
		const [actionError, setActionError] = useState(false);
		const [creating, setCreating] = useState(false);

		const selectedRows = useMemo(
			() => rows.filter((row, index) => selection.has(keyOf(row, index))),
			[rows, selection, keyOf],
		);

		const execute = async (
			pending: string,
			fn: () => Promise<unknown>,
			onOk?: () => void,
		): Promise<void> => {
			setPendingId(pending);
			setActionError(false);
			try {
				const res = await fn();
				if (isOkResult(res)) {
					await router.invalidate();
					onOk?.();
				} else {
					setActionError(true);
				}
			} catch {
				setActionError(true);
			} finally {
				setPendingId(null);
			}
		};

		// `def.columns` is stable; `t` is resolved per render.
		const columns = def.columns.map((column) => toColumn(column, t));

		const renderRowAction = (
			action: AdminTableRowAction<Row, M>,
			row: Row,
			rowId: string,
		): ReactNode => {
			if (action.hidden?.(row) === true) return null;
			const pending = `${action.id}:${rowId}`;
			const disabled = action.disabled?.(row) === true;
			const label = resolveText(action.label, t);
			const onRun = () => void execute(pending, () => action.run(row));
			if (action.confirm !== undefined) {
				return (
					<ConfirmAction
						key={action.id}
						trigger={(open) => (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={disabled || pendingId === pending}
								onClick={open}
							>
								{label}
							</Button>
						)}
						{...confirmProps(action.confirm, t)}
						onConfirm={onRun}
					/>
				);
			}
			return (
				<Button
					key={action.id}
					type="button"
					variant="ghost"
					size="sm"
					disabled={disabled || pendingId === pending}
					onClick={onRun}
				>
					{label}
				</Button>
			);
		};

		const renderRowActions = (row: Row): ReactNode => {
			const rowId = keyOf(
				row,
				/* v8 ignore next -- rendered rows always come from `rows`,
				   which is what built indexByRow, so the ?? fallback is dead */
				indexByRow.get(row) ?? 0,
			);
			return (
				<div className="flex justify-end gap-1">
					{rowActions.map((action) => renderRowAction(action, row, rowId))}
				</div>
			);
		};

		const renderBulkAction = (action: AdminTableBulkAction<Row, M>): ReactNode => {
			const pending = `bulk:${action.id}`;
			const label = resolveText(action.label, t);
			const onRun = () =>
				void execute(
					pending,
					() => action.run(selectedRows),
					() => setSelection(new Set<string>()),
				);
			if (action.confirm !== undefined) {
				return (
					<ConfirmAction
						key={action.id}
						trigger={(open) => (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={pendingId === pending}
								onClick={open}
							>
								{label}
							</Button>
						)}
						{...confirmProps(action.confirm, t)}
						onConfirm={onRun}
					/>
				);
			}
			return (
				<Button
					key={action.id}
					type="button"
					variant="ghost"
					size="sm"
					disabled={pendingId === pending}
					onClick={onRun}
				>
					{label}
				</Button>
			);
		};

		const renderBulkBar = (): ReactNode => {
			if (!hasBulkActions || selection.size === 0) return null;
			return (
				<div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
					<span className="text-xs text-muted-foreground">
						{(def.selectedCount ?? KIT_DEFAULTS.selectedCount)(t, selection.size, rows.length)}
					</span>
					{bulkActions.map(renderBulkAction)}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={pendingId !== null}
						onClick={() => setSelection(new Set<string>())}
					>
						{resolveText(def.clearSelection ?? KIT_DEFAULTS.clearSelection, t)}
					</Button>
				</div>
			);
		};

		const headerActions =
			def.headerActions !== undefined || createDef !== undefined ? (
				<>
					{resolveText(def.headerActions, t)}
					{createDef !== undefined ? (
						<Button type="button" size="sm" onClick={() => setCreating(true)}>
							{resolveText(createDef.label, t)}
						</Button>
					) : null}
				</>
			) : undefined;

		const emptyTitle = resolveText(def.empty?.title, t);
		const emptyDescription = resolveText(def.empty?.description, t);
		const empty =
			emptyTitle !== undefined || emptyDescription !== undefined
				? { title: emptyTitle ?? kitT.emptyTitle, description: emptyDescription }
				: undefined;

		const errorText = resolveText(def.actionError ?? KIT_DEFAULTS.actionError, t);

		return (
			<TablePage messages={kitT}>
				<TablePage.Header
					title={resolveText(def.title, t)}
					description={resolveText(def.description, t)}
					actions={headerActions}
				/>
				{actionError && !creating ? <p className="text-xs text-destructive">{errorText}</p> : null}
				<TablePage.Toolbar
					search={
						def.search !== undefined ? (
							<SearchInput
								value={query.q}
								onChange={query.setQ}
								placeholder={resolveText(def.search.placeholder, t) as string | undefined}
								aria-label={resolveText(def.search.label, t) as string | undefined}
							/>
						) : undefined
					}
					resultCount={query.isFiltered ? { shown: query.shown, total: query.total } : undefined}
				/>
				{renderBulkBar()}
				<TablePage.Table
					columns={columns}
					rows={query.rows}
					rowKey={keyOf}
					total={query.total}
					isFiltered={query.isFiltered}
					loading={loading}
					empty={empty}
					noMatch={resolveText(def.noMatch, t)}
					locale={locale}
					selectable={hasBulkActions}
					selected={selection}
					onSelectionChange={setSelection}
					rowActions={hasRowActions ? renderRowActions : undefined}
				/>
				{resolveText(def.extensions, t)}
				{createDef !== undefined && creating ? (
					<FormDialog
						open={creating}
						onOpenChange={setCreating}
						title={resolveText(createDef.title ?? createDef.label, t)}
						description={resolveText(createDef.description, t)}
						fields={typeof createDef.fields === "function" ? createDef.fields(t) : createDef.fields}
						submitLabel={resolveText(createDef.submitLabel ?? "Create", t)}
						cancelLabel={resolveText(createDef.cancelLabel ?? "Cancel", t)}
						error={actionError ? errorText : undefined}
						onSubmit={async (values) => {
							setActionError(false);
							const res = await createDef.onSubmit(values);
							if (isOkResult(res)) {
								await router.invalidate();
								return true;
							}
							setActionError(true);
							return false;
						}}
					/>
				) : null}
			</TablePage>
		);
	};

	AdminTablePage.displayName = `AdminTablePage(${def.id})`;
	return AdminTablePage;
}
