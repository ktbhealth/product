import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { TablePage, viewsMessages, type Column } from "@ktb/views/table";

import { Badge } from "@ktbhealth/ui/components/badge";

import type { CollectionWire } from "../fns.ts";
import { documentStoreMessages, I18N_NAMESPACE } from "../i18n.ts";

export interface CollectionsAdminPageProps {
	readonly collections: readonly CollectionWire[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

/**
 * /platform/document-store — the collections index: every contributed
 * `document.collection` def plus DB-registered rows, with owner,
 * version, field count and record count. Rows link into the
 * collection's document browser (/platform/document-store/<name>).
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell with a `Column` model; the kit's empty state replaces the
 * old dashed placeholder.
 */
export function CollectionsAdminPage({ collections, i18n, locale }: CollectionsAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, documentStoreMessages(locale));

	const columns: Column<CollectionWire>[] = [
		{
			key: "name",
			header: t.colName,
			render: (row) => <span className="font-mono text-xs">{row.name}</span>,
		},
		{
			key: "owner",
			header: t.colOwner,
			render: (row) => (
				<span className="text-muted-foreground">{row.owner === "" ? t.none : row.owner}</span>
			),
		},
		{
			key: "version",
			header: t.colVersion,
			render: (row) => <span className="text-muted-foreground">{row.version}</span>,
		},
		{
			key: "fields",
			header: t.colFields,
			align: "right",
			value: (row) => Object.keys(row.fields).length,
		},
		{ key: "recordCount", header: t.colRecords, align: "right" },
		{
			key: "status",
			header: t.colStatus,
			render: (row) => (
				<div className="flex flex-wrap items-center gap-1">
					<Badge variant={row.contributed ? "default" : "secondary"}>
						{row.contributed ? t.statusContributed : t.statusDbOnly}
					</Badge>
					{row.registered ? null : <Badge variant="outline">{t.badgeUnregistered}</Badge>}
				</div>
			),
		},
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (row) => (
				<div className="flex items-center justify-end">
					<Link
						to={`/platform/document-store/${row.name}` as "/"}
						className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
						aria-label={t.open}
					>
						{t.open}
						<ArrowRightIcon className="size-4" />
					</Link>
				</div>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale ?? "en")}>
			<TablePage.Header title={t.title} description={t.description} />
			<TablePage.Table
				columns={columns}
				rows={collections}
				rowKey={(row) => row.name}
				empty={{ title: t.emptyCollectionsTitle, description: t.emptyCollectionsDescription }}
				locale={locale}
			/>
		</TablePage>
	);
}
