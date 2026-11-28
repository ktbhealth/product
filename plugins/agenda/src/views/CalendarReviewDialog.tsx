import { useState } from "react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import type { AgendaMessages } from "../i18n.ts";
import { asDate, patientLabel } from "./-shared.ts";
import type { AgendaPatientOption } from "./AgendaPage.tsx";

/** One event the import couldn't place — carried in memory only, never
 * persisted server-side (titles stay out of the database by design). */
export interface CalendarReviewItem {
	readonly externalEventId: string;
	readonly title: string;
	readonly startsAt: Date | string;
	readonly endsAt: Date | string;
	readonly reason: "patient-needed" | "ambiguous-patient" | "all-day" | "cancelled";
}

export type CalendarReviewResolution =
	| { readonly ok: true; readonly status: "created" | "existing" | "conflict" }
	| { readonly ok: false };

const ACTIONABLE: ReadonlySet<CalendarReviewItem["reason"]> = new Set([
	"patient-needed",
	"ambiguous-patient",
]);

const reasonLabel = (reason: CalendarReviewItem["reason"], t: AgendaMessages): string =>
	reason === "patient-needed"
		? t.calendar.review.patientNeeded
		: reason === "ambiguous-patient"
			? t.calendar.review.ambiguousPatient
			: reason === "all-day"
				? t.calendar.review.allDay
				: t.calendar.review.cancelled;

const fmtWhen = (startsAt: Date | string, endsAt: Date | string): string => {
	const start = asDate(startsAt);
	const end = asDate(endsAt);
	const date = start.toLocaleDateString();
	const span = `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	return `${date} ${span}`;
};

function ReviewRow({
	item,
	patients,
	t,
	resolve,
	onDone,
}: {
	readonly item: CalendarReviewItem;
	readonly patients: readonly AgendaPatientOption[];
	readonly t: AgendaMessages;
	readonly resolve: (
		item: CalendarReviewItem,
		patientId: number,
	) => Promise<CalendarReviewResolution>;
	readonly onDone: (externalEventId: string, scheduled: boolean) => void;
}) {
	const actionable = ACTIONABLE.has(item.reason);
	const patientItems = patients.map((p) => ({
		value: String(p.id),
		label: patientLabel(p.name, p.id, t),
	}));
	const [patientId, setPatientId] = useState<string>("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<"conflict" | "failed" | null>(null);

	const schedule = async () => {
		if (patientId === "" || busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await resolve(item, Number(patientId));
			if (!res.ok) {
				setError("failed");
				return;
			}
			if (res.status === "conflict") {
				setError("conflict");
				return;
			}
			onDone(item.externalEventId, true);
		} catch {
			setError("failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2 rounded-md border p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate font-medium">{item.title}</div>
					<div className="text-sm text-muted-foreground">{fmtWhen(item.startsAt, item.endsAt)}</div>
				</div>
				<Badge variant="outline" className="shrink-0">
					{reasonLabel(item.reason, t)}
				</Badge>
			</div>
			{actionable ? (
				<div className="flex items-center gap-2">
					<Select
						items={patientItems}
						value={patientId === "" ? null : patientId}
						onValueChange={(v) => setPatientId(v === null ? "" : String(v))}
					>
						<SelectTrigger aria-label={t.calendar.review.pickPatient} className="w-full">
							<SelectValue placeholder={t.calendar.review.pickPatient} />
						</SelectTrigger>
						<SelectContent>
							{patientItems.map((p) => (
								<SelectItem key={p.value} value={p.value}>
									{p.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button size="sm" disabled={patientId === "" || busy} onClick={() => void schedule()}>
						{busy ? <Spinner /> : null}
						{busy ? t.calendar.review.scheduling : t.calendar.review.schedule}
					</Button>
				</div>
			) : null}
			{error === "conflict" ? (
				<div className="text-sm text-destructive">{t.calendar.review.conflict}</div>
			) : null}
			{error === "failed" ? (
				<div className="text-sm text-destructive">{t.calendar.review.failed}</div>
			) : null}
			<div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onDone(item.externalEventId, false)}
					disabled={busy}
				>
					{t.calendar.review.ignore}
				</Button>
			</div>
		</div>
	);
}

/** Post-import review: every event the importer refused to guess on,
 * with the actions the doctor can take — pick a patient and schedule,
 * or ignore. Closing discards the list; re-running the import brings
 * back whatever is still unresolved (the import is idempotent). */
export function CalendarReviewDialog({
	items,
	patients,
	t,
	resolve,
	onDone,
	onClose,
}: {
	readonly items: readonly CalendarReviewItem[];
	readonly patients: readonly AgendaPatientOption[];
	readonly t: AgendaMessages;
	readonly resolve: (
		item: CalendarReviewItem,
		patientId: number,
	) => Promise<CalendarReviewResolution>;
	readonly onDone: (externalEventId: string, scheduled: boolean) => void;
	readonly onClose: () => void;
}) {
	return (
		<Dialog open={items.length > 0} onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t.calendar.review.title}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					{items.map((item) => (
						<ReviewRow
							key={item.externalEventId}
							item={item}
							patients={patients}
							t={t}
							resolve={resolve}
							onDone={onDone}
						/>
					))}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						{t.calendar.review.close}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
