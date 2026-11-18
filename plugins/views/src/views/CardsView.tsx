import type { PageI18nSlice } from "@ktb/kernel";
import { Link } from "@tanstack/react-router";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";

import type { ViewField } from "../definition.ts";
import type { ViewMessages } from "../i18n.ts";
import type { ViewListWire, ViewRecordWire } from "../wire.ts";
import { FilterBar } from "./FilterBar.tsx";
import { useViewFilters } from "./use-view-filters.ts";
import { fieldLabel, formatViewValue, getPath, resolveViewText } from "./view-utils.ts";

/**
 * `kind: "cards"` list view — one card per record. The card title
 * comes from `cardTitleField` (matched against `fields` for its
 * format; falls back to the first field, then `#<id>`); the remaining
 * fields render as label/value rows. Filter bar and pagination behave
 * exactly like the table view.
 */
export interface CardsViewProps {
	readonly wire: ViewListWire;
	readonly messages: ViewMessages;
	readonly locale: string;
	readonly i18n?: PageI18nSlice;
	readonly onQuery: (offset: number, values: Readonly<Record<string, string>>) => void;
	readonly busy?: boolean;
}

/** Resolve the field that titles a card: the declared
 * `cardTitleField` when it names a rendered field, else the first
 * field. */
const titleFieldFor = (wire: ViewListWire): ViewField => {
	const { def } = wire;
	// `fields` is validated non-empty at composition time.
	return def.fields.find((f) => f.field === def.cardTitleField) ?? (def.fields[0] as ViewField);
};

const cardTitle = (wire: ViewListWire, row: ViewRecordWire, locale: string): string => {
	const field = titleFieldFor(wire);
	const value = getPath(row.data, field.field);
	if (value === undefined || value === null) return `#${row.id}`;
	return formatViewValue(field, value, { locale, refs: wire.refs });
};

export function CardsView({ wire, messages, locale, i18n, onQuery, busy }: CardsViewProps) {
	const { def } = wire;
	const { values, apply } = useViewFilters(wire, onQuery);
	const pageCount = Math.max(1, Math.ceil(wire.total / wire.pageSize));
	const current = Math.floor(wire.offset / wire.pageSize) + 1;
	const titleField = titleFieldFor(wire);

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
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{wire.rows.map((row) => (
						<Card key={row.id}>
							<CardHeader>
								<CardTitle className="text-base">
									<Link to={`${wire.path}/${row.id}`} className="hover:underline">
										{cardTitle(wire, row, locale)}
									</Link>
								</CardTitle>
								<CardDescription className="font-mono text-xs">#{row.id}</CardDescription>
							</CardHeader>
							<CardContent>
								<dl className="flex flex-col gap-1 text-sm">
									{def.fields
										.filter((f) => f !== titleField)
										.map((field) => (
											<div key={field.field} className="flex justify-between gap-3">
												<dt className="text-muted-foreground">
													{resolveViewText(i18n, fieldLabel(field))}
												</dt>
												<dd className="truncate text-right">
													{formatViewValue(field, getPath(row.data, field.field), {
														locale,
														refs: wire.refs,
													})}
												</dd>
											</div>
										))}
								</dl>
							</CardContent>
						</Card>
					))}
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
