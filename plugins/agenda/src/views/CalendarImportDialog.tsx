import { useState } from "react";

import { overlapWindowFilter } from "@ktb/calendar";
import type { FilterExpr } from "@ktb/filters";
import { Button } from "@ktbhealth/ui/components/button";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import type { AgendaMessages } from "../i18n.ts";

/** Google event types the dialog offers — opaque provider values on the
 * wire, mapped to localized labels here. `default` is Google's name for
 * regular events. */
const EVENT_TYPE_KEYS = ["default", "outOfOffice", "focusTime", "birthday"] as const;
type EventTypeKey = (typeof EVENT_TYPE_KEYS)[number];

const dateInputValue = (date: Date): string => {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Current-month default range in the user's own timezone: first day of
 * this month → first day of the next. */
const currentMonthRange = (now: Date): readonly [string, string] => {
	const start = new Date(now.getFullYear(), now.getMonth(), 1);
	const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	return [dateInputValue(start), dateInputValue(end)] as const;
};

/** Compose the filter AST from the dialog inputs. The date range always
 * rides as overlap conditions (local midnight boundaries); optional
 * inputs drop out when blank, so the minimal filter is just the window. */
export const buildImportFilter = (input: {
	readonly dateFrom: string;
	readonly dateTo: string;
	readonly text: string;
	readonly location: string;
	readonly participant: string;
	readonly eventTypes: readonly string[];
	readonly tagKey: string;
	readonly tagValue: string;
}): FilterExpr | null => {
	if (input.dateFrom === "" || input.dateTo === "") return null;
	const from = new Date(`${input.dateFrom}T00:00:00`);
	const toExclusive = new Date(`${input.dateTo}T00:00:00`);
	toExclusive.setDate(toExclusive.getDate() + 1);
	if (Number.isNaN(from.getTime()) || Number.isNaN(toExclusive.getTime())) return null;
	const window = overlapWindowFilter(from, toExclusive);
	const conditions: FilterExpr[] = [...window.args];
	const text = input.text.trim();
	if (text !== "") conditions.push({ op: "contains", field: "text", value: text });
	const location = input.location.trim();
	if (location !== "") conditions.push({ op: "contains", field: "location", value: location });
	const participant = input.participant.trim();
	if (participant !== "")
		conditions.push({ op: "contains", field: "attendee", value: participant });
	if (input.eventTypes.length > 0)
		conditions.push({ op: "in", field: "eventType", values: [...input.eventTypes] });
	const tagKey = input.tagKey.trim();
	const tagValue = input.tagValue.trim();
	if (tagKey !== "" && tagValue !== "")
		conditions.push({ op: "eq", field: `property.${tagKey}`, value: tagValue });
	return { op: "and", args: conditions };
};

const typeLabel = (key: EventTypeKey, t: AgendaMessages): string =>
	key === "default"
		? t.calendar.filters.typeDefault
		: key === "outOfOffice"
			? t.calendar.filters.typeOutOfOffice
			: key === "focusTime"
				? t.calendar.filters.typeFocusTime
				: t.calendar.filters.typeBirthday;

/** Pre-import filter dialog: the doctor frames what comes in — date
 * range (defaulting to the current month), free text, location,
 * participant, event types and a tag key=value pair. Everything composes
 * conjunctively into the @ktb/filters AST the server hands to the
 * provider adapter. */
export function CalendarImportDialog({
	open,
	busy,
	t,
	onImport,
	onClose,
}: {
	readonly open: boolean;
	readonly busy: boolean;
	readonly t: AgendaMessages;
	readonly onImport: (filter: FilterExpr) => void;
	readonly onClose: () => void;
}) {
	const [initialFrom, initialTo] = currentMonthRange(new Date());
	const [dateFrom, setDateFrom] = useState(initialFrom);
	const [dateTo, setDateTo] = useState(initialTo);
	const [text, setText] = useState("");
	const [location, setLocation] = useState("");
	const [participant, setParticipant] = useState("");
	const [eventTypes, setEventTypes] = useState<readonly EventTypeKey[]>([]);
	const [tagKey, setTagKey] = useState("");
	const [tagValue, setTagValue] = useState("");

	const toggleType = (key: EventTypeKey, checked: boolean) => {
		setEventTypes((current) =>
			checked ? [...current, key] : current.filter((entry) => entry !== key),
		);
	};

	const submit = () => {
		const filter = buildImportFilter({
			dateFrom,
			dateTo,
			text,
			location,
			participant,
			eventTypes,
			tagKey,
			tagValue,
		});
		if (filter === null || busy) return;
		onImport(filter);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t.calendar.filters.title}</DialogTitle>
				</DialogHeader>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<div className="grid grid-cols-2 gap-3">
						<Field>
							<FieldLabel htmlFor="import-date-from">{t.calendar.filters.dateFrom}</FieldLabel>
							<Input
								id="import-date-from"
								type="date"
								value={dateFrom}
								onChange={(e) => setDateFrom(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="import-date-to">{t.calendar.filters.dateTo}</FieldLabel>
							<Input
								id="import-date-to"
								type="date"
								value={dateTo}
								onChange={(e) => setDateTo(e.target.value)}
							/>
						</Field>
					</div>
					<Field>
						<FieldLabel htmlFor="import-text">{t.calendar.filters.textQuery}</FieldLabel>
						<Input
							id="import-text"
							value={text}
							placeholder={t.calendar.filters.textPlaceholder}
							onChange={(e) => setText(e.target.value)}
						/>
					</Field>
					<div className="grid grid-cols-2 gap-3">
						<Field>
							<FieldLabel htmlFor="import-location">{t.calendar.filters.location}</FieldLabel>
							<Input
								id="import-location"
								value={location}
								placeholder={t.calendar.filters.locationPlaceholder}
								onChange={(e) => setLocation(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="import-participant">{t.calendar.filters.participant}</FieldLabel>
							<Input
								id="import-participant"
								value={participant}
								placeholder={t.calendar.filters.participantPlaceholder}
								onChange={(e) => setParticipant(e.target.value)}
							/>
						</Field>
					</div>
					<Field>
						<FieldLabel>{t.calendar.filters.eventTypes}</FieldLabel>
						<div className="grid grid-cols-2 gap-2">
							{EVENT_TYPE_KEYS.map((key) => (
								<label key={key} className="flex items-center gap-2 text-sm">
									<Checkbox
										checked={eventTypes.includes(key)}
										onCheckedChange={(v) => toggleType(key, v === true)}
									/>
									{typeLabel(key, t)}
								</label>
							))}
						</div>
					</Field>
					<Field>
						<FieldLabel>{t.calendar.filters.tag}</FieldLabel>
						<div className="grid grid-cols-2 gap-3">
							<Input
								aria-label={t.calendar.filters.tagKeyPlaceholder}
								value={tagKey}
								placeholder={t.calendar.filters.tagKeyPlaceholder}
								onChange={(e) => setTagKey(e.target.value)}
							/>
							<Input
								aria-label={t.calendar.filters.tagValuePlaceholder}
								value={tagValue}
								placeholder={t.calendar.filters.tagValuePlaceholder}
								onChange={(e) => setTagValue(e.target.value)}
							/>
						</div>
					</Field>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
							{t.calendar.filters.cancel}
						</Button>
						<Button type="submit" disabled={busy || dateFrom === "" || dateTo === ""}>
							{busy ? <Spinner /> : null}
							{busy ? t.calendar.importing : t.calendar.filters.apply}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
