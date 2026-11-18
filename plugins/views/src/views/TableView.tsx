import type { PageI18nSlice } from "@ktb/kernel";
import { Link } from "@tanstack/react-router";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import type { ViewMessages } from "../i18n.ts";
import type { ViewListWire } from "../wire.ts";
import { FilterBar } from "./FilterBar.tsx";
import { useViewFilters } from "./use-view-filters.ts";
import { ViewValue } from "./ViewValue.tsx";
import { fieldLabel, getPath, resolveViewText } from "./view-utils.ts";

/**
 * `kind: "table"` list view — columns come straight from the def's
 * `fields` (label/format/width), rows link through to the view's
 * detail mode (`/v/<key>/<id>`), the filter bar binds declared
 * interactive filters to URL search params, and pagination calls back
 * into the page's refetch.
 */
export interface TableViewProps {
	readonly wire: ViewListWire;
	readonly messages: ViewMessages;
	readonly locale: string;
	readonly i18n?: PageI18nSlice;
	readonly onQuery: (offset: number, values: Readonly<Record<string, string>>) => void;
	readonly busy?: boolean;
}

export function TableView({ wire, messages, locale, i18n, onQuery, busy }: TableViewProps) {
	const { def } = wire;
	const { values, apply } = useViewFilters(wire, onQuery);
	const pageCount = Math.max(1, Math.ceil(wire.total / wire.pageSize));
	const current = Math.floor(wire.offset / wire.pageSize) + 1;

	return (
		<div className="flex flex-col gap-4">
			<FilterBar
				def={def}
				messages={messages}
				values={values}
				disabled={busy}
				onChange={(next) => apply(next)}
			/>
			{wire.rows.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
					<p className="text-sm font-medium">{messages.emptyTitle}</p>
					<p className="mt-1 text-sm text-muted-foreground">{messages.emptyDescription}</p>
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								{def.fields.map((field) => (
									<TableHead
										key={field.field}
										className="whitespace-nowrap"
										style={field.width === undefined ? undefined : { width: field.width }}
									>
										{resolveViewText(i18n, fieldLabel(field))}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{wire.rows.map((row) => (
								<TableRow key={row.id}>
									{def.fields.map((field, i) => {
										const value = getPath(row.data, field.field);
										const cell = (
											<ViewValue field={field} value={value} locale={locale} refs={wire.refs} />
										);
										return (
											<TableCell key={field.field} className="max-w-48 truncate text-sm">
												{i === 0 ? (
													<Link
														to={`${wire.path}/${row.id}`}
														className="font-medium text-primary hover:underline"
													>
														{cell}
													</Link>
												) : (
													cell
												)}
											</TableCell>
										);
									})}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			{wire.total > wire.pageSize ? (
				<div className="mt-4 flex items-center justify-between">
					<p className="text-sm text-muted-foreground">{messages.pageInfo(current, pageCount)}</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={busy || wire.offset === 0}
							onClick={() => onQuery(Math.max(0, wire.offset - wire.pageSize), values)}
						>
							{messages.prevPage}
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={busy || wire.offset + wire.pageSize >= wire.total}
							onClick={() => onQuery(wire.offset + wire.pageSize, values)}
						>
							{messages.nextPage}
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}
