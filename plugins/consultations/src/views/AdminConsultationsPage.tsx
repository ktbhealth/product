import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { OwnerOption } from "@ktb/patients";
import { viewsMessages } from "@ktb/views";
import {
	ConfirmAction,
	SearchInput,
	TablePage,
	useServerMutation,
	useTableQuery,
	type Column,
} from "@ktb/views/table";
import { LocalDateTime } from "@ktb/views/views";

import { Button } from "@ktbhealth/ui/components/button";

import { adminDeleteConsultationFn } from "../fns.ts";
import type { AdminConsultationRow } from "../index.ts";
import { consultationMessages, I18N_NAMESPACE } from "../i18n.ts";
import type { ConsultationPatientOption } from "../platform-page.tsx";
import { AdminConsultationCreateDialog } from "./AdminConsultationCreateDialog.tsx";

const rowLabel = (c: AdminConsultationRow) =>
	c.patientName ?? c.ownerName ?? c.ownerEmail ?? `#${c.id}`;

/**
 * /platform/consultations console view — cross-owner consultation
 * list/create/delete for platform admins. Records stay immutable:
 * there is no edit (a consultation is a signed record); delete runs
 * through the destructive ConfirmAction and purges the recording.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell, `useTableQuery` client-side search and `useServerMutation`
 * for the delete envelope. The create dialog stays plugin-local —
 * its owner/patient pickers do not fit the kit's `FormDialog`.
 */
export function AdminConsultationsPage({
	consultations,
	owners,
	patients,
	i18n,

	locale = "en",
}: {
	consultations: AdminConsultationRow[];
	/** User accounts for the create form's owner picker. */
	owners: OwnerOption[];
	/** Patients for the create form's patient picker. */
	patients: ConsultationPatientOption[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const [creating, setCreating] = useState(false);

	const del = useServerMutation<number>((args) => adminDeleteConsultationFn(args));

	const query = useTableQuery<AdminConsultationRow>({
		rows: consultations,
		search: {
			predicate: (c, needle) =>
				[c.patientName, c.ownerName, c.ownerEmail]
					.filter(Boolean)
					.join(" ")
					.toLowerCase()
					.includes(needle),
		},
	});

	const columns: Column<AdminConsultationRow>[] = [
		{
			key: "id",
			header: t.admin.colId,
			width: "3.5rem",
			render: (c) => <span className="text-xs text-muted-foreground">{c.id}</span>,
		},
		{
			key: "status",
			header: t.admin.colStatus,
			render: (c) => <span className="font-medium">{c.status}</span>,
		},
		{
			key: "source",
			header: t.admin.colSource,
			render: (c) => <span className="text-muted-foreground">{c.source}</span>,
		},
		{
			key: "patient",
			header: t.admin.colPatient,
			render: (c) =>
				c.patientName ? (
					<Link
						to="/consultations/$id"
						params={{ id: String(c.id) }}
						className="font-medium hover:underline"
					>
						{c.patientName}
					</Link>
				) : (
					"—"
				),
		},
		{
			key: "owner",
			header: t.admin.colOwner,
			render: (c) => c.ownerName ?? c.ownerEmail ?? "—",
		},
		{
			key: "audioStatus",
			header: t.admin.colAudio,
			render: (c) => <span className="text-muted-foreground">{c.audioStatus}</span>,
		},
		{
			key: "createdAt",
			header: t.admin.colCreated,
			align: "right",
			render: (c) => (
				<span className="text-muted-foreground">
					<LocalDateTime value={c.createdAt} locale={locale} />
				</span>
			),
		},
		{
			key: "actions",
			header: t.admin.colActions,
			align: "right",
			width: "4rem",
			render: (c) => (
				<ConfirmAction
					trigger={(open) => (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label={t.admin.deleteFor(rowLabel(c))}
							onClick={open}
						>
							<Trash2Icon />
						</Button>
					)}
					title={t.admin.deleteTitle}
					description={t.admin.deleteDescription(rowLabel(c))}
					confirmLabel={t.admin.deleteConfirm}
					cancelLabel={t.admin.cancel}
					variant="destructive"
					onConfirm={() => del.mutate(c.id)}
				/>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={t.admin.title}
				description={
					consultations.length === 0 ? t.admin.none : t.admin.count(consultations.length)
				}
				actions={
					<Button size="sm" onClick={() => setCreating(true)}>
						<PlusIcon />
						{t.admin.newConsultation}
					</Button>
				}
			/>
			{consultations.length === 0 ? null : (
				<TablePage.Toolbar
					search={
						<SearchInput
							value={query.q}
							onChange={query.setQ}
							placeholder={t.admin.searchPlaceholder}
							aria-label={t.admin.searchLabel}
						/>
					}
					resultCount={
						query.isFiltered ? t.admin.filteredCount(query.shown, query.total) : undefined
					}
				/>
			)}
			<TablePage.Table
				columns={columns}
				rows={query.rows}
				total={query.total}
				isFiltered={query.isFiltered}
				empty={{ title: t.admin.emptyTitle, description: t.admin.emptyDescription }}
				noMatch={t.admin.noMatch}
				locale={locale}
			/>
			{creating ? (
				<AdminConsultationCreateDialog
					owners={owners}
					patients={patients}
					t={t}
					onClose={() => setCreating(false)}
				/>
			) : null}
		</TablePage>
	);
}
