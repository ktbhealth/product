import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { LocalDateTime } from "@ktb/views/views";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@ktbhealth/ui/components/native-select";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

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

	return (
		<PageContainer>
			<PageHeader title={t.documentsTitle} description={t.documentsDescription} />
			<div className="mt-4 flex flex-wrap items-center gap-2">
				<NativeSelect
					aria-label={t.allCollections}
					value={collection}
					onChange={(e) => {
						const name = e.target.value;
						setCollection(name);
						void fetchPage(0, name);
					}}
				>
					<NativeSelectOption value="">{t.allCollections}</NativeSelectOption>
					{collections.map((c) => (
						<NativeSelectOption key={c.name} value={c.name}>
							{c.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			{loadFailed ? <p className="mt-3 text-sm text-destructive">{t.loadFailed}</p> : null}
			{page.rows.length === 0 ? (
				<div className="mt-4 rounded-lg border border-dashed border-border px-6 py-10 text-center">
					<p className="text-sm font-medium">{t.emptyBrowseTitle}</p>
					<p className="mt-1 text-sm text-muted-foreground">{t.emptyBrowseDescription}</p>
				</div>
			) : (
				<div className="mt-4 overflow-x-auto rounded-lg border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.colId}</TableHead>
								<TableHead>{t.colCollection}</TableHead>
								<TableHead>{t.colScope}</TableHead>
								<TableHead>{t.colData}</TableHead>
								<TableHead>{t.colUpdated}</TableHead>
								<TableHead className="text-right">{t.colActions}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{page.rows.map((row) => (
								<TableRow key={`${row.collection}:${row.id}`}>
									<TableCell className="font-mono text-xs">{row.id}</TableCell>
									<TableCell className="font-mono text-xs">{row.collection}</TableCell>
									<TableCell>{scopeBadge(row)}</TableCell>
									<TableCell className="max-w-64 truncate font-mono text-xs">
										{preview(row.data)}
									</TableCell>
									<TableCell className="whitespace-nowrap text-muted-foreground">
										<LocalDateTime value={row.updatedAt} locale={locale} />
									</TableCell>
									<TableCell>
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
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			{page.total > PAGE_SIZE ? (
				<div className="mt-4 flex items-center justify-between">
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
				</div>
			) : null}
		</PageContainer>
	);
}
