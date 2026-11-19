import { Link, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { viewsMessages } from "@ktb/views";
import { SearchInput, TablePage, useTableQuery, type Column } from "@ktb/views/table";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button, buttonVariants } from "@ktbhealth/ui/components/button";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";

import { patientDeleteApi } from "../apis.ts";
import type { AdminPatientRow, OwnerOption } from "../index.ts";
import { patientMessages, I18N_NAMESPACE } from "../i18n.ts";
import { isCipheredPatient } from "../zk.ts";
import { AdminPatientCreateDialog } from "./AdminPatientCreateDialog.tsx";
import { DeletePatientDialog } from "./DeletePatientDialog.tsx";

/**
 * /platform/patients console view — cross-owner patient CRUD for
 * platform admins. Dense/utilitarian by design (system console).
 * Edit reuses the owner-facing form (admin override in the service);
 * delete runs the same cascade dialog as the doctor surface.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell + `useTableQuery` client-side search with the same
 * name/owner predicate as before, plus the synthetic-rows toggle in
 * the toolbar's `filters` slot (the pool is filtered before the query
 * so search never sees hidden synthetic rows). The primitives are
 * used rather than a declarative def — the name cell mixes a router
 * `Link`, a ZK opaque label and a conditional badge, and the
 * create/delete flows are plugin-local dialogs.
 */
export function AdminPatientsPage({
	patients,
	owners,
	i18n,
	locale = "en",
}: {
	patients: AdminPatientRow[];
	/** User accounts for the create form's owner picker. */
	owners: OwnerOption[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, patientMessages(locale));
	const router = useRouter();
	const [showSynthetic, setShowSynthetic] = useState(false);
	const [creating, setCreating] = useState(false);
	const [toDelete, setToDelete] = useState<{ id: number; name: string } | null>(null);

	// Synthetic rows (eval validator cohorts) stay hidden unless the
	// admin asks for them — real records are the default view. The pool
	// is filtered BEFORE the query so the search needle only ever sees
	// visible rows.
	const pool = useMemo(
		() => (showSynthetic ? patients : patients.filter((p) => !p.synthetic)),
		[patients, showSynthetic],
	);

	const query = useTableQuery<AdminPatientRow>({
		rows: pool,
		search: {
			predicate: (p, needle) =>
				[p.name, p.ownerName, p.ownerEmail]
					.filter(Boolean)
					.join(" ")
					.toLowerCase()
					.includes(needle),
		},
	});

	const columns: Column<AdminPatientRow>[] = [
		{
			key: "id",
			header: t.admin.colId,
			width: "3.5rem",
			render: (p) => <span className="text-xs text-muted-foreground">{p.id}</span>,
		},
		{
			key: "name",
			header: t.admin.colName,
			render: (p) => (
				<span className="font-medium">
					{isCipheredPatient(p) ? (
						// ZK row (T-144): the console has no keys —
						// the envelope stays opaque.
						<span className="text-muted-foreground">{t.zk.lockedRecord}</span>
					) : (
						<Link to="/patients/$id" params={{ id: String(p.id) }} className="hover:underline">
							{p.name}
						</Link>
					)}
					{p.synthetic === true && (
						<Badge variant="outline" className="ml-2">
							{t.admin.syntheticBadge}
						</Badge>
					)}
				</span>
			),
		},
		{
			key: "ownerName",
			header: t.admin.colOwner,
			value: (p) => p.ownerName ?? p.ownerEmail,
		},
		{
			key: "ownerId",
			header: t.admin.colOwnerId,
			render: (p) => <span className="text-xs text-muted-foreground">{p.ownerId}</span>,
		},
		{ key: "createdAt", header: t.admin.colCreated, align: "right", format: "datetime" },
		{
			key: "actions",
			header: t.admin.colActions,
			align: "right",
			width: "6rem",
			render: (p) => {
				const rowName = isCipheredPatient(p) ? t.zk.lockedRecord : p.name;
				return (
					<div className="flex justify-end gap-1">
						{/* Real link, not Button render=: it navigates, so it
						    keeps link semantics (and avoids the Base UI
						    nativeButton warning). */}
						<Link
							to="/patients/$id/edit"
							params={{ id: String(p.id) }}
							aria-label={t.actions.editFor(rowName)}
							className={buttonVariants({ variant: "ghost", size: "icon" })}
						>
							<PencilIcon />
						</Link>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t.actions.deleteFor(rowName)}
							onClick={() => setToDelete({ id: p.id, name: rowName })}
						>
							<Trash2Icon />
						</Button>
					</div>
				);
			},
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={t.admin.title}
				description={patients.length === 0 ? t.admin.none : t.admin.count(patients.length)}
				actions={
					<Button size="sm" onClick={() => setCreating(true)}>
						<PlusIcon />
						{t.admin.newPatient}
					</Button>
				}
			/>
			{patients.length === 0 ? null : (
				<TablePage.Toolbar
					search={
						<SearchInput
							value={query.q}
							onChange={query.setQ}
							placeholder={t.admin.searchPlaceholder}
							aria-label={t.admin.searchLabel}
						/>
					}
					filters={
						<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<Checkbox
								checked={showSynthetic}
								onCheckedChange={(v) => setShowSynthetic(v === true)}
							/>
							{t.admin.showSynthetic}
						</label>
					}
					resultCount={
						query.isFiltered ? t.admin.filteredCount(query.shown, patients.length) : undefined
					}
				/>
			)}
			<TablePage.Table
				columns={columns}
				rows={query.rows}
				// `total` stays the FULL patient count (synthetic included)
				// so a pool emptied only by the synthetic toggle still gets
				// the filtered-empty `noMatch` row, exactly like before.
				total={patients.length}
				isFiltered={query.isFiltered}
				empty={{ title: t.admin.emptyTitle, description: t.admin.emptyDescription }}
				noMatch={t.admin.noMatch}
				locale={locale}
			/>
			{creating ? (
				<AdminPatientCreateDialog
					owners={owners}
					t={t}
					locale={locale}
					i18n={i18n}
					onClose={() => setCreating(false)}
				/>
			) : null}
			<DeletePatientDialog
				patient={toDelete}
				api={patientDeleteApi}
				t={t}
				onClose={() => setToDelete(null)}
				onDeleted={() => {
					setToDelete(null);
					void router.invalidate();
				}}
			/>
		</TablePage>
	);
}
