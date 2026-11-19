import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PlusIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { viewsMessages } from "@ktb/views";
import {
	ConfirmAction,
	SearchInput,
	TablePage,
	useServerMutation,
	useTableQuery,
	type Column,
} from "@ktb/views/table";

import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ktbhealth/ui/components/alert-dialog";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";

import type { AdminUserRow } from "../index.ts";
import { deleteUserFn, setUserSuspendedFn } from "../fns.ts";
import { userMessages, I18N_NAMESPACE } from "../i18n.ts";
import { AdminUserCreateDialog } from "./AdminUserCreateDialog.tsx";
import { AdminUserEditDialog } from "./AdminUserEditDialog.tsx";

/**
 * /platform/users console view — cross-owner user listing for platform
 * admins. Dense/utilitarian by design (system console). Suspend goes
 * through a destructive ConfirmAction; delete goes through an
 * AlertDialog (kept open on failure so the reason renders inline);
 * edit opens a dialog. Reactivate is a plain action. Mutations go
 * through the plugin's server fns; the loader re-runs on
 * `router.invalidate()`.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell, `useTableQuery` client-side search and `useServerMutation`
 * for the suspend/reactivate envelope. The create/edit/delete dialogs
 * stay plugin-local — the kit's `FormDialog`/`ConfirmAction` cannot
 * express their per-field error mapping and inline delete errors.
 */
export function AdminUsersPage({
	users,
	i18n,
	locale = "en",
}: {
	users: AdminUserRow[];
	/** Active UI locale, injected by the host via the panel page ctx. */
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, userMessages(locale));
	const router = useRouter();
	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<AdminUserRow | null>(null);
	const [deleting, setDeleting] = useState<AdminUserRow | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);

	const suspend = useServerMutation<{ userId: string; suspended: boolean }>(setUserSuspendedFn);
	const busy = suspend.busy || deleteBusy;

	const query = useTableQuery<AdminUserRow>({
		rows: users,
		search: { keys: ["name", "email"] },
	});

	const removeUser = async (user: AdminUserRow) => {
		setDeleteBusy(true);
		setDeleteError(null);
		try {
			const res = await deleteUserFn({ data: { userId: user.id } });
			if (!res.ok) {
				setDeleteError(res.error === "is_admin" ? t.cannotDeleteAdmin : t.deleteFailed);
				return;
			}
			setDeleting(null);
			await router.invalidate();
		} finally {
			setDeleteBusy(false);
		}
	};

	const suspendAction = (u: AdminUserRow) =>
		u.banned ? (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={busy}
				onClick={() => void suspend.mutate({ userId: u.id, suspended: false })}
			>
				{t.reactivate}
			</Button>
		) : (
			<ConfirmAction
				trigger={(open) => (
					<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={open}>
						{t.suspend}
					</Button>
				)}
				title={t.suspendTitle}
				description={t.suspendDescription(u.email)}
				confirmLabel={t.suspendConfirm}
				cancelLabel={t.cancel}
				variant="destructive"
				onConfirm={() => suspend.mutate({ userId: u.id, suspended: true })}
			/>
		);

	const columns: Column<AdminUserRow>[] = [
		{
			key: "id",
			header: t.colId,
			width: "3.5rem",
			render: (u) => <span className="text-xs text-muted-foreground">{u.id}</span>,
		},
		{
			key: "name",
			header: t.colName,
			render: (u) => <span className="font-medium">{u.name}</span>,
		},
		{ key: "email", header: t.colEmail },
		{
			key: "emailVerified",
			header: t.colVerified,
			render: (u) => (u.emailVerified ? t.yes : t.no),
		},
		{
			key: "patientCount",
			header: t.colPatients,
			align: "right",
			render: (u) => <span className="text-xs">{u.patientCount}</span>,
		},
		{
			key: "consultationCount",
			header: t.colConsultations,
			align: "right",
			render: (u) => <span className="text-xs">{u.consultationCount}</span>,
		},
		{
			key: "isAdmin",
			header: t.colRole,
			render: (u) =>
				u.isAdmin ? (
					<span className="text-xs font-semibold text-foreground">{t.roleAdmin}</span>
				) : (
					<span className="text-muted-foreground">{t.roleUser}</span>
				),
		},
		{
			key: "banned",
			header: t.colStatus,
			render: (u) =>
				u.banned ? (
					<Badge variant="destructive">{t.statusSuspended}</Badge>
				) : (
					<span className="text-muted-foreground">{t.statusActive}</span>
				),
		},
		{ key: "createdAt", header: t.colCreated, align: "right", format: "datetime" },
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (u) => (
				<div className="flex items-center justify-end gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => setEditing(u)}
					>
						{t.editUser}
					</Button>
					{suspendAction(u)}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="text-destructive hover:text-destructive"
						disabled={busy}
						onClick={() => {
							setDeleteError(null);
							setDeleting(u);
						}}
					>
						{t.deleteUser}
					</Button>
				</div>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={t.title}
				description={users.length === 0 ? t.none : t.count(users.length)}
				actions={
					<Button size="sm" onClick={() => setCreating(true)}>
						<PlusIcon />
						{t.createUser}
					</Button>
				}
			/>
			{suspend.error ? <p className="text-xs text-destructive">{t.saveError}</p> : null}
			{users.length === 0 ? null : (
				<TablePage.Toolbar
					search={
						<SearchInput
							value={query.q}
							onChange={query.setQ}
							placeholder={t.searchPlaceholder}
							aria-label={t.searchLabel}
						/>
					}
					resultCount={query.isFiltered ? t.filteredCount(query.shown, query.total) : undefined}
				/>
			)}
			<TablePage.Table
				columns={columns}
				rows={query.rows}
				total={query.total}
				isFiltered={users.length > 0 && query.isFiltered}
				empty={{ title: t.emptyTitle, description: t.emptyDescription }}
				noMatch={t.noMatch}
				locale={locale}
			/>
			{creating ? <AdminUserCreateDialog t={t} onClose={() => setCreating(false)} /> : null}
			{editing !== null ? (
				<AdminUserEditDialog t={t} user={editing} onClose={() => setEditing(null)} />
			) : null}
			{deleting !== null ? (
				<AlertDialog
					open
					onOpenChange={(open) => {
						/* v8 ignore next -- mounted only while deleting; only close events fire */
						if (!open) {
							setDeleting(null);
							setDeleteError(null);
						}
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t.deleteTitle}</AlertDialogTitle>
							<AlertDialogDescription>{t.deleteDescription(deleting.email)}</AlertDialogDescription>
						</AlertDialogHeader>
						{deleteError !== null ? (
							<p className="text-sm text-destructive">{deleteError}</p>
						) : null}
						<AlertDialogFooter>
							<AlertDialogCancel disabled={busy}>{t.cancel}</AlertDialogCancel>
							<Button
								type="button"
								variant="destructive"
								disabled={busy}
								onClick={() => void removeUser(deleting)}
							>
								{t.deleteConfirm}
							</Button>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
		</TablePage>
	);
}
