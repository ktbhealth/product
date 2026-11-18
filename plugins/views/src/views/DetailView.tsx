import type { PageI18nSlice } from "@ktb/kernel";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";

import type { ViewMessages } from "../i18n.ts";
import type { ViewDetailWire } from "../wire.ts";
import { ViewValue } from "./ViewValue.tsx";
import { fieldLabel, getPath, resolveViewText } from "./view-utils.ts";

/**
 * Detail mode (`/v/<key>/<docId>`) — a labeled-fields layout over
 * `detailFields` (defaulting to `fields`). `record: null` renders the
 * localized not-found state; the back link returns to the view's
 * list mount.
 */
export interface DetailViewProps {
	readonly wire: ViewDetailWire;
	readonly messages: ViewMessages;
	readonly locale: string;
	readonly i18n?: PageI18nSlice;
}

export function DetailView({ wire, messages, locale, i18n }: DetailViewProps) {
	const { def, record } = wire;
	const title = resolveViewText(i18n, def.title);
	const fields = def.detailFields ?? def.fields;

	return (
		<div className="flex flex-col gap-4">
			<Button
				size="sm"
				variant="ghost"
				nativeButton={false}
				render={<Link to={wire.path} />}
				className="self-start"
			>
				<ArrowLeftIcon className="size-4" />
				{messages.backToView(title)}
			</Button>
			{record === null ? (
				<Empty className="py-16">
					<EmptyHeader>
						<EmptyTitle>{messages.recordNotFoundTitle}</EmptyTitle>
						<EmptyDescription>{messages.recordNotFoundDescription}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<Card className="max-w-2xl">
					<CardHeader>
						<CardTitle>{title}</CardTitle>
					</CardHeader>
					<CardContent>
						<dl className="flex flex-col gap-3 text-sm">
							{fields.map((field) => (
								<div key={field.field} className="flex flex-col gap-0.5">
									<dt className="text-muted-foreground">
										{resolveViewText(i18n, fieldLabel(field))}
									</dt>
									<dd className="break-words">
										<ViewValue
											field={field}
											value={getPath(record.data, field.field)}
											locale={locale}
											refs={wire.refs}
										/>
									</dd>
								</div>
							))}
						</dl>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
