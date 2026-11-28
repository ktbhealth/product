import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
	CalendarClockIcon,
	CalendarDaysIcon,
	CalendarRangeIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ListIcon,
	LockIcon,
	PencilIcon,
	PlayIcon,
	PlusIcon,
	UserXIcon,
	XIcon,
} from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageContext, PageI18nSlice } from "@ktb/kernel";
import { isEnvelope } from "@ktb/patients/zk";
import { LocalDateTime } from "@ktb/views/views";

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
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import { agendaMessages, I18N_NAMESPACE, type AgendaMessages } from "../i18n.ts";
import type { AppointmentStatus } from "../schema.ts";
import { agendaApi } from "../apis.ts";
import { AGENDA_WINDOW } from "../window.ts";
import { MonthGrid, monthGridDays, WeekGrid } from "./-calendar.tsx";
import type { FilterExpr } from "@ktb/filters";

import { CalendarImportDialog } from "./CalendarImportDialog.tsx";
import { CalendarReviewDialog, type CalendarReviewItem } from "./CalendarReviewDialog.tsx";
import {
	addDays,
	addMonths,
	asDate,
	dayKey,
	hhmm,
	isLive,
	patientLabel,
	startOfDay,
	STATUS_TONES,
	statusLabel,
	weekStart,
} from "./-shared.ts";

// ---------- wire shapes ----------

/** Appointment as the page reads it — timestamps tolerate the string
 * shape loader serialization produces. */
export interface AgendaListItem {
	readonly id: number;
	readonly patientId: number;
	readonly patientName: string | null;
	readonly status: string;
	readonly startsAt: Date | string;
	readonly durationMin: number;
	readonly consultationId: number | null;
	readonly note: string | null;
	readonly reminderSentAt: Date | string | null;
}

/** Patient options for the create/edit dialog — the owner-scoped list. */
export interface AgendaPatientOption {
	readonly id: number;
	readonly name: string | null;
}

/** What the form submits — startsAt is the local wall time picked. */
export interface AppointmentDraft {
	readonly patientId: number;
	readonly startsAt: Date;
	readonly durationMin?: number;
	readonly note?: string | null;
}

/** Write result — `reason: "conflict"` marks a double-booking (P-119-A). */
export interface AppointmentWriteResult {
	readonly ok: boolean;
	readonly reason?: "conflict";
}

export interface CalendarConnectionState {
	readonly provider: string;
	readonly calendarId: string;
	readonly status: string;
	readonly lastSyncAt: Date | string | null;
}

export interface CalendarImportOutcome {
	readonly imported: number;
	readonly existing: number;
	readonly skipped: number;
	readonly review: readonly CalendarReviewItem[];
	readonly conflicts: readonly unknown[];
}

/** The view-facing write surface — bound to the plugin's server fns
 * (./apis.ts) in the mounted page, a stub in tests. `list` (T-259)
 * fetches calendar ranges outside the loader window; without it the
 * view shows what the loader brought. */
export interface AgendaApi {
	readonly create: (draft: AppointmentDraft) => Promise<AppointmentWriteResult>;
	readonly update: (
		id: number,
		patch: Partial<AppointmentDraft>,
	) => Promise<AppointmentWriteResult>;
	readonly setStatus: (id: number, status: AppointmentStatus) => Promise<{ readonly ok: boolean }>;
	readonly start: (
		id: number,
	) => Promise<{ readonly ok: boolean; readonly consultationId?: number }>;
	readonly list?: (
		from: Date,
		to: Date,
	) => Promise<
		{ readonly ok: true; readonly appointments: readonly AgendaListItem[] } | { readonly ok: false }
	>;
	readonly calendarConnection?: () => Promise<
		| { readonly ok: true; readonly connection: CalendarConnectionState | null }
		| { readonly ok: false }
	>;
	readonly importGoogleCalendar?: (input: {
		readonly filter?: FilterExpr;
	}) => Promise<
		| { readonly ok: true; readonly result: CalendarImportOutcome }
		| { readonly ok: false; readonly reason?: "not-connected" | "unavailable" | "provider-error" }
	>;
	readonly resolveCalendarImportItem?: (input: {
		readonly externalEventId: string;
		readonly startsAt: Date;
		readonly endsAt: Date;
		readonly patientId: number;
	}) => Promise<
		| {
				readonly ok: true;
				readonly result: { readonly status: "created" | "existing" | "conflict" };
		  }
		| { readonly ok: false }
	>;
}

export type AgendaView = "list" | "week" | "month";

/** "About to start" highlight window — mirrors REMINDER_LEAD_MS. */
const SOON_MS = 15 * 60 * 1000;

/** Visible days for a view: one clinic week, or the 6-week month grid. */
const visibleDays = (view: AgendaView, anchor: Date): Date[] =>
	view === "month"
		? monthGridDays(anchor)
		: Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i));

/** True when [from, to) lies inside the loader's window around `now`. */
const insideLoaderWindow = (from: Date, to: Date, now: number) =>
	from.getTime() >= startOfDay(new Date(now - AGENDA_WINDOW.pastDays * 86_400_000)).getTime() &&
	to.getTime() <= now + AGENDA_WINDOW.aheadDays * 86_400_000;

/**
 * Doctor agenda (P-008, calendar views T-259): a List | Week | Month
 * switch over one anchor date. List groups a clinic week by day; Week is
 * a time grid (click an empty slot to book it); Month is a day grid
 * (click a day to open its week). Ranges outside the loader window are
 * fetched through `api.list`. Mutations go through the injected `api`,
 * refresh via `onChanged` and start-navigation via `onStarted`. A
 * secretary acting as the doctor sees and edits the same agenda — the
 * loaders run under the doctor-resolved Principal either way.
 */
export function AgendaPage({
	appointments,
	patients,
	api,
	i18n,
	locale = "en",
	portalBase = "",
	initialView = "list",
	onChanged,
	onStarted,
}: {
	readonly appointments: readonly AgendaListItem[];
	readonly patients: readonly AgendaPatientOption[];
	readonly api: AgendaApi;
	readonly i18n?: PageI18nSlice;
	readonly locale?: string;
	readonly portalBase?: string;
	readonly initialView?: AgendaView;
	readonly onChanged?: () => void;
	readonly onStarted?: (consultationId: number) => void;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, agendaMessages(locale));
	const [view, setView] = useState<AgendaView>(initialView);
	const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
	const [creatingAt, setCreatingAt] = useState<Date | null>(null);
	const [editing, setEditing] = useState<AgendaListItem | null>(null);
	const [selected, setSelected] = useState<AgendaListItem | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);
	const [failed, setFailed] = useState(false);
	// Ranges fetched outside the loader window, keyed by range; `reload`
	// re-fetches the visible one after a mutation.
	const [fetched, setFetched] = useState<Readonly<Record<string, readonly AgendaListItem[]>>>({});
	const [reload, setReload] = useState(0);
	const [now] = useState(() => Date.now());
	const [calendarConnected, setCalendarConnected] = useState<boolean | null>(null);
	const [calendarBusy, setCalendarBusy] = useState(false);
	const [reviewItems, setReviewItems] = useState<readonly CalendarReviewItem[]>([]);
	const [importDialogOpen, setImportDialogOpen] = useState(false);
	const [calendarMessage, setCalendarMessage] = useState<string | null>(null);

	useEffect(() => {
		if (api.calendarConnection === undefined) return;
		void api
			.calendarConnection()
			.catch(() => ({ ok: false }) as const)
			.then((res) => setCalendarConnected(res.ok && res.connection !== null));
	}, [api]);

	// OAuth callbacks return here through a full navigation carrying a
	// one-shot `calendarImport` outcome. Surface it, then strip the query
	// so a refresh does not repeat stale feedback.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const outcome = params.get("calendarImport");
		if (outcome === null) return;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- the browser query string is the external system here
		setCalendarMessage(
			outcome === "connected"
				? t.calendar.connected
				: outcome === "calendar-unavailable"
					? t.calendar.unavailable
					: t.calendar.failed,
		);
		params.delete("calendarImport");
		const query = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${query === "" ? "" : `?${query}`}${window.location.hash}`,
		);
	}, [t]);

	const importGoogleCalendar = () => {
		if (calendarConnected !== true) {
			window.location.assign("/api/calendar/google/connect");
			return;
		}
		if (api.importGoogleCalendar === undefined || calendarBusy) return;
		setImportDialogOpen(true);
	};

	const runImport = async (filter: FilterExpr) => {
		if (api.importGoogleCalendar === undefined || calendarBusy) return;
		setCalendarBusy(true);
		setCalendarMessage(null);
		try {
			const res = await api.importGoogleCalendar({ filter });
			if (!res.ok) {
				if (res.reason === "not-connected") {
					setCalendarConnected(false);
					window.location.assign("/api/calendar/google/connect");
					return;
				}
				setCalendarMessage(t.calendar.failed);
				return;
			}
			setImportDialogOpen(false);
			setCalendarMessage(
				t.calendar.result(
					res.result.imported,
					res.result.existing,
					res.result.review.length,
					res.result.conflicts.length,
				),
			);
			if (res.result.review.length > 0) setReviewItems(res.result.review);
			refresh();
		} catch {
			setCalendarMessage(t.calendar.failed);
		} finally {
			setCalendarBusy(false);
		}
	};

	const days = useMemo(() => visibleDays(view, anchor), [view, anchor]);
	const [rangeFrom, rangeTo] = useMemo(
		() => [days[0]!, addDays(days[days.length - 1]!, 1)] as const,
		[days],
	);
	const rangeKey = `${dayKey(rangeFrom)}/${dayKey(rangeTo)}`;
	const needsFetch = api.list !== undefined && !insideLoaderWindow(rangeFrom, rangeTo, now);

	useEffect(() => {
		if (!needsFetch) return;
		void api.list!(rangeFrom, rangeTo)
			.catch(() => ({ ok: false }) as const)
			.then((res) => {
				if (res.ok) setFetched((f) => ({ ...f, [rangeKey]: res.appointments }));
			});
	}, [rangeFrom, rangeTo, rangeKey, needsFetch, reload, api]);

	// Loader rows, overridden by any fetched copy of the same id.
	const items = useMemo(() => {
		const byId = new Map(appointments.map((a) => [a.id, a]));
		for (const a of fetched[rangeKey] ?? []) byId.set(a.id, a);
		return [...byId.values()].filter((a) => {
			const at = asDate(a.startsAt).getTime();
			return at >= rangeFrom.getTime() && at < rangeTo.getTime();
		});
	}, [appointments, fetched, rangeFrom, rangeTo, rangeKey]);

	const refresh = () => {
		onChanged?.();
		setReload((r) => r + 1);
	};

	const act = async (id: number, op: () => Promise<{ readonly ok: boolean }>) => {
		setBusyId(id);
		setFailed(false);
		try {
			const res = await op();
			if (!res.ok) {
				setFailed(true);
				return;
			}
			setSelected(null);
			refresh();
		} finally {
			setBusyId(null);
		}
	};

	const start = async (a: AgendaListItem) => {
		setBusyId(a.id);
		setFailed(false);
		try {
			const res = await api.start(a.id);
			if (!res.ok || res.consultationId === undefined) {
				setFailed(true);
				return;
			}
			onStarted?.(res.consultationId);
		} finally {
			setBusyId(null);
		}
	};

	const step = (dir: -1 | 1) =>
		setAnchor((d) => (view === "month" ? addMonths(d, dir) : addDays(d, dir * 7)));

	const card = (a: AgendaListItem) => (
		<AppointmentCard
			key={a.id}
			a={a}
			t={t}
			now={now}
			busy={busyId === a.id}
			portalBase={portalBase}
			onStart={() => void start(a)}
			onStatus={(status) => void act(a.id, () => api.setStatus(a.id, status))}
			onEdit={() => {
				setSelected(null);
				setEditing(a);
			}}
		/>
	);

	const todayKey = dayKey(new Date(now));

	return (
		<div className={`mx-auto p-6 ${view === "list" ? "max-w-4xl" : "max-w-6xl"}`}>
			<PageHeader
				icon={<CalendarClockIcon />}
				title={t.title}
				actions={
					<span className="flex items-center gap-2">
						{api.calendarConnection !== undefined ? (
							<Button
								variant="outline"
								size="sm"
								disabled={calendarBusy || calendarConnected === null}
								onClick={importGoogleCalendar}
							>
								<CalendarDaysIcon />
								{calendarBusy
									? t.calendar.importing
									: calendarConnected === true
										? t.calendar.importGoogle
										: t.calendar.connectGoogle}
							</Button>
						) : null}
						<Button size="sm" onClick={() => setCreatingAt(new Date())}>
							<PlusIcon /> {t.newAppointment}
						</Button>
					</span>
				}
			/>
			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				<div role="tablist" aria-label={t.title} className="inline-flex rounded-lg bg-muted p-0.5">
					{(["list", "week", "month"] as const).map((v) => (
						<button
							key={v}
							type="button"
							role="tab"
							aria-selected={view === v}
							onClick={() => setView(v)}
							className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm ${
								view === v ? "bg-background font-medium shadow-sm" : "text-muted-foreground"
							}`}
						>
							{v === "list" ? (
								<ListIcon className="size-4" />
							) : v === "week" ? (
								<CalendarRangeIcon className="size-4" />
							) : (
								<CalendarDaysIcon className="size-4" />
							)}
							{t.views[v]}
						</button>
					))}
				</div>
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium capitalize" data-testid="range-label">
						{view === "month" ? (
							<LocalDateTime
								value={anchor}
								locale={locale}
								options={{ month: "long", year: "numeric" }}
							/>
						) : (
							<>
								<LocalDateTime
									value={days[0]!}
									locale={locale}
									options={{ day: "numeric", month: "short" }}
								/>
								{" – "}
								<LocalDateTime
									value={days[6]!}
									locale={locale}
									options={{ day: "numeric", month: "short", year: "numeric" }}
								/>
							</>
						)}
					</span>
					<Button
						variant="outline"
						size="sm"
						onClick={() => step(-1)}
						aria-label={view === "month" ? t.previousMonth : t.previousWeek}
					>
						<ChevronLeftIcon />
					</Button>
					<Button variant="outline" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
						{t.today}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => step(1)}
						aria-label={view === "month" ? t.nextMonth : t.nextWeek}
					>
						<ChevronRightIcon />
					</Button>
				</div>
			</div>
			{failed ? <p className="mt-3 text-sm text-destructive">{t.form.required}</p> : null}
			{calendarMessage ? (
				<p className="mt-3 text-sm text-muted-foreground">{calendarMessage}</p>
			) : null}
			<div className="mt-6">
				{view === "week" ? (
					<WeekGrid
						days={days}
						items={items}
						t={t}
						locale={locale}
						now={now}
						onSelect={setSelected}
						onCreateAt={setCreatingAt}
					/>
				) : view === "month" ? (
					<MonthGrid
						month={anchor}
						items={items}
						t={t}
						locale={locale}
						now={now}
						onPickDay={(day) => {
							setAnchor(day);
							setView("week");
						}}
					/>
				) : (
					<div className="space-y-6">
						{days.map((day) => {
							const dayItems = items
								.filter((a) => dayKey(asDate(a.startsAt)) === dayKey(day))
								.sort((x, y) => asDate(x.startsAt).getTime() - asDate(y.startsAt).getTime());
							return (
								<section key={dayKey(day)}>
									<h2
										className={`text-sm font-semibold tracking-wide uppercase ${
											dayKey(day) === todayKey ? "text-primary" : "text-muted-foreground"
										}`}
									>
										<LocalDateTime value={day} locale={locale} options={{ weekday: "short" }} /> ·{" "}
										<LocalDateTime
											value={day}
											locale={locale}
											options={{ day: "numeric", month: "short" }}
										/>
									</h2>
									<div className="mt-2 space-y-2">{dayItems.map(card)}</div>
								</section>
							);
						})}
						{items.length === 0 ? (
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<CalendarClockIcon />
									</EmptyMedia>
									<EmptyTitle>{t.title}</EmptyTitle>
									<EmptyDescription>{t.empty}</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : null}
					</div>
				)}
			</div>
			{selected !== null ? (
				<Dialog
					open
					onOpenChange={(open) => {
						/* v8 ignore next -- this dialog only reports closes; the open transition never reaches the handler */
						if (!open) setSelected(null);
					}}
				>
					<DialogContent className="sm:max-w-2xl">
						<DialogHeader>
							<DialogTitle>
								{t.detailsTitle} ·{" "}
								<LocalDateTime
									value={asDate(selected.startsAt)}
									locale={locale}
									options={{ weekday: "long", day: "numeric", month: "long" }}
								/>
							</DialogTitle>
						</DialogHeader>
						{card(selected)}
					</DialogContent>
				</Dialog>
			) : null}
			{creatingAt !== null ? (
				<AppointmentFormDialog
					patients={patients}
					start={creatingAt}
					t={t}
					onSubmit={async (draft) => {
						const res = await api.create(draft);
						if (!res.ok) return res.reason ?? "failed";
						setCreatingAt(null);
						refresh();
						return "ok";
					}}
					onClose={() => setCreatingAt(null)}
				/>
			) : null}
			{editing !== null ? (
				<AppointmentFormDialog
					patients={patients}
					initial={editing}
					start={asDate(editing.startsAt)}
					t={t}
					onSubmit={async (draft) => {
						const res = await api.update(editing.id, draft);
						if (!res.ok) return res.reason ?? "failed";
						setEditing(null);
						refresh();
						return "ok";
					}}
					onClose={() => setEditing(null)}
				/>
			) : null}
			<CalendarImportDialog
				open={importDialogOpen}
				busy={calendarBusy}
				t={t}
				onImport={(filter) => void runImport(filter)}
				onClose={() => setImportDialogOpen(false)}
			/>
			<CalendarReviewDialog
				items={reviewItems}
				patients={patients}
				t={t}
				resolve={async (item, patientId) => {
					if (api.resolveCalendarImportItem === undefined) return { ok: false };
					const res = await api.resolveCalendarImportItem({
						externalEventId: item.externalEventId,
						startsAt: asDate(item.startsAt),
						endsAt: asDate(item.endsAt),
						patientId,
					});
					if (!res.ok) return { ok: false };
					return { ok: true, status: res.result.status };
				}}
				onDone={(externalEventId, scheduled) => {
					setReviewItems((current) =>
						current.filter((entry) => entry.externalEventId !== externalEventId),
					);
					if (scheduled) refresh();
				}}
				onClose={() => setReviewItems([])}
			/>
		</div>
	);
}

/** One appointment with its actions — a list row, and the body of the
 * calendar's details dialog. */
function AppointmentCard({
	a,
	t,
	now,
	busy,
	portalBase,
	onStart,
	onStatus,
	onEdit,
}: {
	readonly a: AgendaListItem;
	readonly t: AgendaMessages;
	readonly now: number;
	readonly busy: boolean;
	readonly portalBase: string;
	readonly onStart: () => void;
	readonly onStatus: (status: AppointmentStatus) => void;
	readonly onEdit: () => void;
}) {
	const startsAt = asDate(a.startsAt);
	const soon =
		isLive(a.status) && startsAt.getTime() - now <= SOON_MS && startsAt.getTime() - now > 0;
	return (
		<div
			className={`flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 ${
				soon ? "border-primary/40" : "border-border"
			}`}
		>
			<span className="w-14 font-mono text-sm font-semibold">{hhmm(startsAt)}</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium">
					{isEnvelope(a.patientName) ? (
						<span className="inline-flex items-center gap-1.5 text-muted-foreground">
							<LockIcon className="size-3.5" /> {t.zk.lockedName}
						</span>
					) : (
						(a.patientName ?? `#${a.patientId}`)
					)}
				</span>
				<span className="block text-xs text-muted-foreground">
					{t.durationMin(a.durationMin)}
					{a.note ? ` · ${a.note}` : ""}
				</span>
			</span>
			{soon ? (
				<Badge variant="secondary" className="ring-1 ring-primary/20 bg-primary/10 text-primary">
					{t.startingSoon(Math.max(1, Math.round((startsAt.getTime() - now) / 60000)))}
				</Badge>
			) : null}
			<Badge
				variant="secondary"
				className={`ring-1 ${STATUS_TONES[a.status] ?? STATUS_TONES.completed}`}
			>
				{statusLabel(t, a.status)}
			</Badge>
			<span className="flex items-center gap-1">
				{a.consultationId !== null ? (
					<Button
						nativeButton={false}
						variant="outline"
						size="sm"
						render={<Link to={`${portalBase}/consultations/${a.consultationId}/record`} />}
					>
						<PlayIcon /> {t.actions.started}
					</Button>
				) : isLive(a.status) ? (
					<Button variant="outline" size="sm" disabled={busy} onClick={onStart}>
						<PlayIcon /> {t.actions.start}
					</Button>
				) : null}
				{a.status === "scheduled" ? (
					<Button variant="ghost" size="sm" disabled={busy} onClick={() => onStatus("confirmed")}>
						<CheckIcon /> {t.actions.confirm}
					</Button>
				) : null}
				{a.status === "confirmed" ? (
					<>
						<Button variant="ghost" size="sm" disabled={busy} onClick={() => onStatus("completed")}>
							<CheckIcon /> {t.actions.complete}
						</Button>
						<Button variant="ghost" size="sm" disabled={busy} onClick={() => onStatus("no_show")}>
							<UserXIcon /> {t.actions.noShow}
						</Button>
					</>
				) : null}
				{isLive(a.status) ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							aria-label={t.actions.edit}
							onClick={onEdit}
						>
							<PencilIcon />
						</Button>
						<Button variant="ghost" size="sm" disabled={busy} onClick={() => onStatus("cancelled")}>
							<XIcon /> {t.actions.cancel}
						</Button>
					</>
				) : null}
			</span>
		</div>
	);
}

/** Create/edit dialog — patient, day, time, duration, note. */
function AppointmentFormDialog({
	patients,
	initial,
	start,
	t,
	onSubmit,
	onClose,
}: {
	readonly patients: readonly AgendaPatientOption[];
	readonly initial?: AgendaListItem | null;
	/** Prefilled date/time — the edited row's, "now", or a clicked week slot. */
	readonly start: Date;
	readonly t: AgendaMessages;
	readonly onSubmit: (draft: AppointmentDraft) => Promise<"ok" | "conflict" | "failed">;
	readonly onClose: () => void;
}) {
	const init = start;
	const patientItems = [
		{ value: null, label: `— ${t.form.required}` },
		...patients.map((p) => ({ value: String(p.id), label: patientLabel(p.name, p.id, t) })),
	];
	const [patientId, setPatientId] = useState(initial ? String(initial.patientId) : "");
	const [date, setDate] = useState(dayKey(init));
	const [time, setTime] = useState(hhmm(init));
	const [durationMin, setDurationMin] = useState(String(initial?.durationMin ?? 30));
	const [note, setNote] = useState(initial?.note ?? "");
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<false | "conflict" | "failed">(false);

	const submit = async () => {
		/* v8 ignore next -- the submit button is disabled while patientId is empty or busy */
		if (patientId === "" || busy) return;
		const startsAt = new Date(`${date}T${time}`);
		if (Number.isNaN(startsAt.getTime())) {
			setFailed("failed");
			return;
		}
		setBusy(true);
		setFailed(false);
		try {
			const outcome = await onSubmit({
				patientId: Number(patientId),
				startsAt,
				durationMin: Number(durationMin) || undefined,
				...(note.trim() === "" ? {} : { note: note.trim() }),
			});
			if (outcome !== "ok") setFailed(outcome);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				/* v8 ignore next -- this dialog only reports closes; the open transition never reaches the handler */
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t.newAppointment}</DialogTitle>
				</DialogHeader>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<Field>
						<FieldLabel>{t.form.patient}</FieldLabel>
						<Select
							items={patientItems}
							// Base UI models "nothing selected" as null.
							value={patientId === "" ? null : patientId}
							onValueChange={(v) => setPatientId(v === null ? "" : String(v))}
						>
							<SelectTrigger aria-label={t.form.patient} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{patientItems.map((item) => (
									<SelectItem key={item.value ?? ""} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<div className="grid grid-cols-3 gap-3">
						<Field>
							<FieldLabel htmlFor="appointment-date">{t.form.date}</FieldLabel>
							<Input
								id="appointment-date"
								type="date"
								value={date}
								onChange={(e) => setDate(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="appointment-time">{t.form.time}</FieldLabel>
							<Input
								id="appointment-time"
								type="time"
								value={time}
								onChange={(e) => setTime(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="appointment-duration">{t.form.durationMin}</FieldLabel>
							<Input
								id="appointment-duration"
								type="number"
								min={5}
								step={5}
								value={durationMin}
								onChange={(e) => setDurationMin(e.target.value)}
							/>
						</Field>
					</div>
					<Field>
						<FieldLabel htmlFor="appointment-note">{t.form.note}</FieldLabel>
						<Textarea
							id="appointment-note"
							value={note}
							onChange={(e) => setNote(e.target.value)}
							placeholder={t.form.notePlaceholder}
							rows={2}
						/>
					</Field>
					{failed ? (
						<p role="alert" className="text-sm text-destructive">
							{failed === "conflict" ? t.form.conflict : t.form.required}
						</p>
					) : null}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
							{t.form.cancel}
						</Button>
						<Button type="submit" disabled={busy || patientId === ""}>
							{t.form.save}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Portal-mounted descriptor component: resolves the portal base from
 * the live pathname ("/portal/<instance>/agenda"), unwraps the loader
 * payload and wires the real fns-backed api + router refresh. The same
 * descriptor serves every clinical instance — identical pattern to the
 * clinician plugin's page wrappers.
 */
export function AgendaPortalPage({ data, ctx }: { data: unknown; ctx: PageContext }) {
	const router = useRouter();
	const pathname = useLocation({ select: (l) => l.pathname });
	const instance = pathname.split("/")[2] ?? "";
	const portalBase = `/portal/${instance}`;
	const payload = (data ?? {}) as {
		readonly appointments?: AgendaListItem[];
		readonly patients?: AgendaPatientOption[];
	};
	return (
		<AgendaPage
			appointments={payload.appointments ?? []}
			patients={payload.patients ?? []}
			api={agendaApi}
			i18n={ctx.i18n}
			locale={ctx.locale}
			portalBase={portalBase}
			onChanged={() => void router.invalidate()}
			onStarted={(consultationId) =>
				// `/record` opens the recording flow on the fresh shell; once
				// saved the same URL falls back to the detail view (T-257).
				void router.navigate({ to: `${portalBase}/consultations/${consultationId}/record` })
			}
		/>
	);
}
