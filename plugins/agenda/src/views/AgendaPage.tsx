import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
	CalendarClockIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
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

/** The view-facing write surface — bound to the plugin's server fns
 * (./apis.ts) in the mounted page, a stub in tests. */
/** Write result — `reason: "conflict"` marks a double-booking (P-119-A). */
export interface AppointmentWriteResult {
	readonly ok: boolean;
	readonly reason?: "conflict";
}

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
}

// ---------- date helpers (local wall time — clinic-local scheduling) ----------

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Monday of d's week — the clinic week convention. */
const weekStart = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const dayKey = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmm = (d: Date) =>
	`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

// ---------- presentation ----------

const STATUS_TONES: Record<string, string> = {
	scheduled: "bg-info/10 text-info ring-info/20",
	confirmed: "bg-success/10 text-success ring-success/20",
	completed: "bg-muted text-muted-foreground ring-border",
	no_show: "bg-warning/10 text-warning ring-warning/20",
	cancelled: "bg-destructive/10 text-destructive ring-destructive/20",
};

const statusLabel = (t: AgendaMessages, status: string) =>
	({
		scheduled: t.status.scheduled,
		confirmed: t.status.confirmed,
		completed: t.status.completed,
		no_show: t.status.noShow,
		cancelled: t.status.cancelled,
	})[status] ?? status;

/** "About to start" highlight window — mirrors REMINDER_LEAD_MS. */
const SOON_MS = 15 * 60 * 1000;

/** Display label for a patient: `v1.` envelopes (ZK tenant, no device
 * grant) render as the locked placeholder — never the raw ciphertext,
 * same locked-row contract as the patients list. */
const patientLabel = (name: string | null, id: number, t: AgendaMessages) =>
	name === null ? `#${id}` : isEnvelope(name) ? t.zk.lockedName : name;

/**
 * Doctor agenda week view (P-008): day-grouped appointment list for
 * one clinic week. Navigation is client-side over the loader's window;
 * mutations go through the injected `api`, refresh via `onChanged` and
 * start-navigation via `onStarted`. A secretary acting as the doctor
 * sees and edits the same agenda — the loaders run under the
 * doctor-resolved Principal either way.
 */
export function AgendaPage({
	appointments,
	patients,
	api,
	i18n,
	locale = "en",
	portalBase = "",
	onChanged,
	onStarted,
}: {
	readonly appointments: readonly AgendaListItem[];
	readonly patients: readonly AgendaPatientOption[];
	readonly api: AgendaApi;
	readonly i18n?: PageI18nSlice;
	readonly locale?: string;
	readonly portalBase?: string;
	readonly onChanged?: () => void;
	readonly onStarted?: (consultationId: number) => void;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, agendaMessages(locale));
	const refresh = () => onChanged?.();
	const [weekOffset, setWeekOffset] = useState(0);
	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<AgendaListItem | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);
	const [failed, setFailed] = useState(false);

	const week = useMemo(() => {
		const start = addDays(weekStart(new Date()), weekOffset * 7);
		return Array.from({ length: 7 }, (_, i) => addDays(start, i));
	}, [weekOffset]);

	const byDay = useMemo(() => {
		const map = new Map<string, AgendaListItem[]>();
		for (const a of appointments) {
			const key = dayKey(asDate(a.startsAt));
			map.set(key, [...(map.get(key) ?? []), a]);
		}
		return map;
	}, [appointments]);

	const act = async (id: number, op: () => Promise<{ readonly ok: boolean }>) => {
		setBusyId(id);
		setFailed(false);
		try {
			const res = await op();
			if (!res.ok) {
				setFailed(true);
				return;
			}
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

	const todayKey = dayKey(new Date());
	const now = Date.now();

	return (
		<div className="mx-auto max-w-4xl p-6">
			<PageHeader
				icon={<CalendarClockIcon />}
				title={t.title}
				actions={
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setWeekOffset((w) => w - 1)}
							aria-label={t.previousWeek}
						>
							<ChevronLeftIcon />
						</Button>
						<Button variant="outline" size="sm" onClick={() => setWeekOffset(0)}>
							{t.today}
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setWeekOffset((w) => w + 1)}
							aria-label={t.nextWeek}
						>
							<ChevronRightIcon />
						</Button>
						<Button size="sm" onClick={() => setCreating(true)}>
							<PlusIcon /> {t.newAppointment}
						</Button>
					</div>
				}
			/>
			{failed ? <p className="mt-3 text-sm text-destructive">{t.form.required}</p> : null}
			<div className="mt-6 space-y-6">
				{week.map((day) => {
					const items = byDay.get(dayKey(day)) ?? [];
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
							<div className="mt-2 space-y-2">
								{items.map((a) => {
									const startsAt = asDate(a.startsAt);
									const soon =
										(a.status === "scheduled" || a.status === "confirmed") &&
										startsAt.getTime() - now <= SOON_MS &&
										startsAt.getTime() - now > 0;
									return (
										<div
											key={a.id}
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
												<Badge
													variant="secondary"
													className="ring-1 ring-primary/20 bg-primary/10 text-primary"
												>
													{t.startingSoon(
														Math.max(1, Math.round((startsAt.getTime() - now) / 60000)),
													)}
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
														render={<Link to={`${portalBase}/consultations/${a.consultationId}`} />}
													>
														<PlayIcon /> {t.actions.started}
													</Button>
												) : a.status === "scheduled" || a.status === "confirmed" ? (
													<Button
														variant="outline"
														size="sm"
														disabled={busyId === a.id}
														onClick={() => void start(a)}
													>
														<PlayIcon /> {t.actions.start}
													</Button>
												) : null}
												{a.status === "scheduled" ? (
													<Button
														variant="ghost"
														size="sm"
														disabled={busyId === a.id}
														onClick={() => void act(a.id, () => api.setStatus(a.id, "confirmed"))}
													>
														<CheckIcon /> {t.actions.confirm}
													</Button>
												) : null}
												{a.status === "confirmed" ? (
													<>
														<Button
															variant="ghost"
															size="sm"
															disabled={busyId === a.id}
															onClick={() => void act(a.id, () => api.setStatus(a.id, "completed"))}
														>
															<CheckIcon /> {t.actions.complete}
														</Button>
														<Button
															variant="ghost"
															size="sm"
															disabled={busyId === a.id}
															onClick={() => void act(a.id, () => api.setStatus(a.id, "no_show"))}
														>
															<UserXIcon /> {t.actions.noShow}
														</Button>
													</>
												) : null}
												{a.status === "scheduled" || a.status === "confirmed" ? (
													<>
														<Button
															variant="ghost"
															size="sm"
															disabled={busyId === a.id}
															aria-label={t.actions.edit}
															onClick={() => setEditing(a)}
														>
															<PencilIcon />
														</Button>
														<Button
															variant="ghost"
															size="sm"
															disabled={busyId === a.id}
															onClick={() => void act(a.id, () => api.setStatus(a.id, "cancelled"))}
														>
															<XIcon /> {t.actions.cancel}
														</Button>
													</>
												) : null}
											</span>
										</div>
									);
								})}
							</div>
						</section>
					);
				})}
				{appointments.length === 0 ? (
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
			{creating ? (
				<AppointmentFormDialog
					patients={patients}
					t={t}
					onSubmit={async (draft) => {
						const res = await api.create(draft);
						if (!res.ok) return res.reason ?? "failed";
						setCreating(false);
						refresh();
						return "ok";
					}}
					onClose={() => setCreating(false)}
				/>
			) : null}
			{editing !== null ? (
				<AppointmentFormDialog
					patients={patients}
					initial={editing}
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
		</div>
	);
}

/** Create/edit dialog — patient, day, time, duration, note. */
function AppointmentFormDialog({
	patients,
	initial,
	t,
	onSubmit,
	onClose,
}: {
	readonly patients: readonly AgendaPatientOption[];
	readonly initial?: AgendaListItem | null;
	readonly t: AgendaMessages;
	readonly onSubmit: (draft: AppointmentDraft) => Promise<"ok" | "conflict" | "failed">;
	readonly onClose: () => void;
}) {
	const init = initial ? asDate(initial.startsAt) : new Date();
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
				void router.navigate({ to: `${portalBase}/consultations/${consultationId}` })
			}
		/>
	);
}
