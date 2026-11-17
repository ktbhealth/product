import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
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
 */
export function CollectionsAdminPage({ collections, i18n, locale }: CollectionsAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, documentStoreMessages(locale));
	return (
		<PageContainer>
			<PageHeader title={t.title} description={t.description} />
			{collections.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
					<p className="text-sm font-medium">{t.emptyCollectionsTitle}</p>
					<p className="mt-1 text-sm text-muted-foreground">{t.emptyCollectionsDescription}</p>
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.colName}</TableHead>
								<TableHead>{t.colOwner}</TableHead>
								<TableHead>{t.colVersion}</TableHead>
								<TableHead className="text-right">{t.colFields}</TableHead>
								<TableHead className="text-right">{t.colRecords}</TableHead>
								<TableHead>{t.colStatus}</TableHead>
								<TableHead className="text-right">{t.colActions}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{collections.map((row) => (
								<TableRow key={row.name}>
									<TableCell className="font-mono text-xs">{row.name}</TableCell>
									<TableCell className="text-muted-foreground">
										{row.owner === "" ? t.none : row.owner}
									</TableCell>
									<TableCell className="text-muted-foreground">{row.version}</TableCell>
									<TableCell className="text-right">{Object.keys(row.fields).length}</TableCell>
									<TableCell className="text-right">{row.recordCount}</TableCell>
									<TableCell>
										<div className="flex flex-wrap items-center gap-1">
											<Badge variant={row.contributed ? "default" : "secondary"}>
												{row.contributed ? t.statusContributed : t.statusDbOnly}
											</Badge>
											{row.registered ? null : (
												<Badge variant="outline">{t.badgeUnregistered}</Badge>
											)}
										</div>
									</TableCell>
									<TableCell>
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
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</PageContainer>
	);
}
