import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { Button } from "@ktbhealth/ui/components/button";
import { LocalDateTime } from "@ktb/views/views";
import { TablePage, type Column } from "@ktb/views/table";

import type { OrchestrationListRow } from "../fns.ts";
import { I18N_NAMESPACE, pipelineMessages } from "../i18n.ts";

export interface PipelinesPageProps {
	/** Loader rows — every stored orchestration def. */
	readonly rows: readonly OrchestrationListRow[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	readonly i18n?: PageI18nSlice;
	readonly locale?: string;
}

const EDITOR_BASE = "/platform/pipelines";

/**
 * /platform/pipelines (P-120 phase 4): the orchestration-def admin
 * table — id, version, node count, updated timestamp. Rows link into
 * the React Flow editor at /platform/pipelines/<id>; "New pipeline"
 * opens the same editor on /platform/pipelines/new.
 */
export function PipelinesPage({ rows, i18n, locale }: PipelinesPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, pipelineMessages(locale));

	const columns: Column<OrchestrationListRow>[] = [
		{
			key: "id",
			header: t.colId,
			render: (row) => (
				<Link
					to={`${EDITOR_BASE}/${row.id}`}
					className="font-medium font-mono text-sm hover:underline"
				>
					{row.id}
				</Link>
			),
		},
		{ key: "version", header: t.colVersion, width: "6rem" },
		{
			key: "description",
			header: t.colDescription,
			render: (row) => <span className="text-muted-foreground">{row.description ?? "—"}</span>,
		},
		{ key: "nodeCount", header: t.colNodes, width: "5rem", align: "right" },
		{
			key: "updatedAt",
			header: t.colUpdated,
			width: "10rem",
			render: (row) => <LocalDateTime value={row.updatedAt} locale={locale} />,
		},
	];

	return (
		<TablePage>
			<TablePage.Header
				title={t.title}
				description={t.description}
				actions={
					<Button nativeButton={false} size="sm" render={<Link to={`${EDITOR_BASE}/new`} />}>
						<PlusIcon className="size-4" />
						{t.newPipeline}
					</Button>
				}
			/>
			{rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t.empty}</p>
			) : (
				<TablePage.Table
					columns={columns}
					rows={rows}
					rowKey={(row) => row.id}
					total={rows.length}
				/>
			)}
		</TablePage>
	);
}
