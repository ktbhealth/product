import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { LocalDateTime } from "@ktb/views/views";
import { TablePage, viewsMessages, type Column } from "@ktb/views/table";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";

import type { CollectionWire, DocumentWire, DocumentsPageWire } from "../wire.ts";
import { browseDocumentsFn } from "../fns.ts";
import { documentStoreMessages, I18N_NAMESPACE } from "../i18n.ts";
import { DOCUMENTS_PAGE_SIZE } from "./field-utils.ts";

const PAGE_SIZE = DOCUMENTS_PAGE_SIZE;
const PREVIEW_LENGTH = 80;

export interface AllDocumentsPageProps {
	/** Every known collection — feeds the scope filter. */
	readonly collections: readonly CollectionWire[];
	/** First page from the panel loader; later pages/filters come from
	 * `browseDocumentsFn`. */
	readonly initialPage: DocumentsPageWire;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

const preview = (value: unknown): string => {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
};

/**
 * /platform/documents — the cross-collection document browser: every
 * stored record across all collections, filterable by collection,
 * with scope badges and a JSON data preview. Rows are read-only here
 * — the "Open" action jumps into the collection's own page
 * (/platform/document-store/<name>) where the field-aware editor
 * lives. Mutations stay on that page; this view only lists.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell with server-driven pagination kept in local state (the
 * collection filter refetches page 0 through `browseDocumentsFn`).
 */
export function AllDocumentsPage({
	collections,
	initialPage,
	i18n,
	locale,
}: AllDocumentsPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, documentStoreMessages(locale));
	const [page, setPage] = useState<DocumentsPageWire>(initialPage);
	const [pageIndex, setPageIndex] = useState(0);
	const [collection, setCollection] = useState("");
	const [loadFailed, setLoadFailed] = useState(false);

	const pageCount = Math.max(1, Math.ceil(page.total / PAGE_SIZE));

	const fetchPage = async (index: number, name: string) => {
		setLoadFailed(false);
		const result = await browseDocumentsFn({
			data: {
				...(name === "" ? {} : { collection: name }),
				limit: PAGE_SIZE,
				offset: index * PAGE_SIZE,
			},
		});
		if (result === null) {
			setLoadFailed(true);
			return;
		}
		setPage(result);
		setPageIndex(index);
	};

	const scopeBadge = (row: DocumentWire) =>
		row.tenantId !== null ? (
			<Badge variant="secondary">{t.scopeTenant(row.tenantId)}</Badge>
		) : row.ownerId !== "" ? (
			<Badge variant="outline">{t.scopeOwner(row.ownerId)}</Badge>
		) : (
			<Badge variant="outline">{t.scopeGlobal}</Badge>
		);

	const columns: Column<DocumentWire>[] = [
		{
			key: "id",
			header: t.colId,
			render: (row) => <span className="font-mono text-xs">{row.id}</span>,
		},
		{
			key: "collection",
			header: t.colCollection,
			render: (row) => <span className="font-mono text-xs">{row.collection}</span>,
		},
		{ key: "scope", header: t.colScope, render: scopeBadge },
		{
			key: "data",
			header: t.colData,
			render: (row) => (
				<span className="block max-w-64 truncate font-mono text-xs">{preview(row.data)}</span>
			),
		},
		{
			key: "updatedAt",
			header: t.colUpdated,
			render: (row) => (
				<span className="whitespace-nowrap text-muted-foreground">
					<LocalDateTime value={row.updatedAt} locale={locale} />
				</span>
			),
		},
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (row) => (
				<div className="flex items-center justify-end">
					{/* Real link — navigates to the collection's
					    document page (link semantics, no nativeButton). */}
					<Link
						to={`/platform/document-store/${row.collection}` as "/"}
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
			<TablePage.Header title={t.documentsTitle} description={t.documentsDescription} />
			<TablePage.Toolbar
				filters={
					<Select
						items={[
							{ value: "", label: t.allCollections },
							...collections.map((c) => ({ value: c.name, label: c.name })),
						]}
						value={collection}
						onValueChange={(v) => {
							const name = v as string;
							setCollection(name);
							void fetchPage(0, name);
						}}
					>
						<SelectTrigger aria-label={t.allCollections} size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="">{t.allCollections}</SelectItem>
							{collections.map((c) => (
								<SelectItem key={c.name} value={c.name}>
									{c.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
			/>
			{loadFailed ? <p className="text-sm text-destructive">{t.loadFailed}</p> : null}
			<TablePage.Table
				columns={columns}
				rows={page.rows}
				rowKey={(row) => `${row.collection}:${row.id}`}
				empty={{ title: t.emptyBrowseTitle, description: t.emptyBrowseDescription }}
				locale={locale}
			/>
			{page.total > PAGE_SIZE ? (
				<TablePage.Footer>
					<p className="text-sm text-muted-foreground">{t.pageInfo(pageIndex + 1, pageCount)}</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={pageIndex === 0}
							onClick={() => void fetchPage(pageIndex - 1, collection)}
						>
							{t.prevPage}
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={pageIndex + 1 >= pageCount}
							onClick={() => void fetchPage(pageIndex + 1, collection)}
						>
							{t.nextPage}
						</Button>
					</div>
				</TablePage.Footer>
			) : null}
		</TablePage>
	);
}
