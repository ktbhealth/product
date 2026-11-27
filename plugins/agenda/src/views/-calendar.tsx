import { LocalDateTime } from "@ktb/views/views";

import type { AgendaMessages } from "../i18n.ts";
import type { AgendaListItem } from "./AgendaPage.tsx";
import {
	addDays,
	asDate,
	dayKey,
	hhmm,
	isLive,
	monthStart,
	patientLabel,
	STATUS_TONES,
	weekStart,
} from "./-shared.ts";

/** Week grid geometry: one row per 30 min, 24px each (48px/hour). */
const SLOT_MIN = 30;
const SLOT_PX = 24;
/** Visible hours unless an appointment falls outside them. */
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 20;

interface Placed {
	readonly a: AgendaListItem;
	readonly start: Date;
	readonly endMs: number;
	readonly lane: number;
	readonly lanes: number;
}

/**
 * Side-by-side lanes for overlapping blocks (a cancelled row may share
 * a slot with its replacement). Greedy per overlap cluster: each block
 * takes the first lane free at its start; the cluster's lane count
 * sizes every block in it.
 */
export function layoutDay(items: readonly AgendaListItem[]): Placed[] {
	const sorted = items
		.map((a) => {
			const start = asDate(a.startsAt);
			return { a, start, endMs: start.getTime() + a.durationMin * 60_000 };
		})
		.sort((x, y) => x.start.getTime() - y.start.getTime());
	const out: Placed[] = [];
	let cluster: Omit<Placed, "lanes">[] = [];
	let laneEnds: number[] = [];
	let clusterEnd = Number.NEGATIVE_INFINITY;
	const flush = () => {
		for (const c of cluster) out.push({ ...c, lanes: laneEnds.length });
		cluster = [];
		laneEnds = [];
	};
	for (const item of sorted) {
		if (item.start.getTime() >= clusterEnd) flush();
		let lane = laneEnds.findIndex((end) => end <= item.start.getTime());
		if (lane === -1) {
			lane = laneEnds.length;
			laneEnds.push(item.endMs);
		} else {
			laneEnds[lane] = item.endMs;
		}
		cluster.push({ ...item, lane });
		clusterEnd = Math.max(clusterEnd, item.endMs);
	}
	flush();
	return out;
}

/** Hour span for the week: the default day, widened to fit every block. */
export function visibleHours(items: readonly AgendaListItem[]): { from: number; to: number } {
	let from = DAY_START_HOUR;
	let to = DAY_END_HOUR;
	for (const a of items) {
		const start = asDate(a.startsAt);
		const startH = start.getHours();
		const end = new Date(start.getTime() + a.durationMin * 60_000);
		// Ending exactly on the hour needs no extra row; midnight caps at 24.
		const endH =
			end.getDate() !== start.getDate() ? 24 : end.getHours() + (end.getMinutes() > 0 ? 1 : 0);
		from = Math.min(from, startH);
		to = Math.max(to, endH);
	}
	return { from, to };
}

const blockTone = (status: string) => STATUS_TONES[status] ?? STATUS_TONES.completed;

/**
 * Week time grid (T-259): day columns × 30-minute rows. Appointments
 * are positioned blocks (click → details); every empty slot is a
 * button that opens "new appointment" at that time. Today's column
 * carries a now-line.
 */
export function WeekGrid({
	days,
	items,
	t,
	locale,
	now,
	onSelect,
	onCreateAt,
}: {
	readonly days: readonly Date[];
	readonly items: readonly AgendaListItem[];
	readonly t: AgendaMessages;
	readonly locale: string;
	readonly now: number;
	readonly onSelect: (a: AgendaListItem) => void;
	readonly onCreateAt: (startsAt: Date) => void;
}) {
	const { from, to } = visibleHours(items);
	const slotsPerDay = ((to - from) * 60) / SLOT_MIN;
	const hours = Array.from({ length: to - from }, (_, i) => from + i);
	const byDay = new Map<string, AgendaListItem[]>();
	for (const a of items) {
		const key = dayKey(asDate(a.startsAt));
		byDay.set(key, [...(byDay.get(key) ?? []), a]);
	}
	const todayKey = dayKey(new Date(now));
	const columns = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;

	return (
		<div className="overflow-x-auto rounded-xl border border-border bg-card">
			<div className="min-w-[640px]">
				<div
					className="sticky top-0 z-10 grid border-b border-border bg-card"
					style={{ gridTemplateColumns: columns }}
				>
					<div />
					{days.map((day) => {
						const today = dayKey(day) === todayKey;
						return (
							<div
								key={dayKey(day)}
								className={`px-2 py-2 text-center text-xs font-semibold uppercase ${
									today ? "text-primary" : "text-muted-foreground"
								}`}
							>
								<LocalDateTime value={day} locale={locale} options={{ weekday: "short" }} />{" "}
								<span
									className={`inline-flex size-6 items-center justify-center rounded-full ${
										today ? "bg-primary text-primary-foreground" : ""
									}`}
								>
									{day.getDate()}
								</span>
							</div>
						);
					})}
				</div>
				<div className="grid" style={{ gridTemplateColumns: columns }}>
					<div className="relative" style={{ height: slotsPerDay * SLOT_PX }}>
						{hours.map((h, i) => (
							<span
								key={h}
								className="absolute right-2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground"
								style={{ top: i * 2 * SLOT_PX }}
							>
								{i === 0 ? null : `${String(h).padStart(2, "0")}:00`}
							</span>
						))}
					</div>
					{days.map((day) => {
						const key = dayKey(day);
						const dayStartMs = new Date(
							day.getFullYear(),
							day.getMonth(),
							day.getDate(),
							from,
						).getTime();
						const nowOffset = ((now - dayStartMs) / 60_000 / SLOT_MIN) * SLOT_PX;
						return (
							<div
								key={key}
								data-day={key}
								className="relative border-l border-border"
								style={{ height: slotsPerDay * SLOT_PX }}
							>
								{Array.from({ length: slotsPerDay }, (_, i) => {
									const at = new Date(dayStartMs + i * SLOT_MIN * 60_000);
									return (
										<button
											key={i}
											type="button"
											aria-label={t.newAt(hhmm(at))}
											onClick={() => onCreateAt(at)}
											className={`absolute inset-x-0 hover:bg-primary/5 focus-visible:bg-primary/10 focus-visible:outline-none ${
												i % 2 === 0
													? "border-t border-border"
													: "border-t border-dashed border-border/50"
											}`}
											style={{ top: i * SLOT_PX, height: SLOT_PX }}
										/>
									);
								})}
								{layoutDay(byDay.get(key) ?? []).map(({ a, start, lane, lanes }) => {
									const top = ((start.getTime() - dayStartMs) / 60_000 / SLOT_MIN) * SLOT_PX;
									const height = Math.max((a.durationMin / SLOT_MIN) * SLOT_PX, SLOT_PX * 0.8);
									const name = patientLabel(a.patientName, a.patientId, t);
									return (
										<button
											key={a.id}
											type="button"
											onClick={() => onSelect(a)}
											aria-label={`${hhmm(start)} ${name}`}
											className={`absolute z-[1] overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight ring-1 ${blockTone(
												a.status,
											)} ${isLive(a.status) ? "" : "line-through opacity-60"}`}
											style={{
												top,
												height,
												left: `calc(${(lane / lanes) * 100}% + 2px)`,
												width: `calc(${100 / lanes}% - 4px)`,
											}}
										>
											<span className="font-mono font-semibold">{hhmm(start)}</span>{" "}
											<span className="font-medium">{name}</span>
										</button>
									);
								})}
								{key === todayKey && nowOffset >= 0 && nowOffset <= slotsPerDay * SLOT_PX ? (
									<div
										data-testid="now-line"
										className="pointer-events-none absolute inset-x-0 z-[2] border-t-2 border-primary"
										style={{ top: nowOffset }}
									>
										<span className="absolute -top-1 -left-1 size-2 rounded-full bg-primary" />
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

/** How many chips a month cell shows before "+N more". */
const MONTH_CELL_MAX = 3;

/** The 6-week (42-day) grid covering `month`, Monday first. */
export const monthGridDays = (month: Date) => {
	const first = weekStart(monthStart(month));
	return Array.from({ length: 42 }, (_, i) => addDays(first, i));
};

/**
 * Month grid (T-259): 6 weeks × 7 days, each cell listing its first
 * appointments ("+N more" past three). Clicking a day hands it back so
 * the page can open that week.
 */
export function MonthGrid({
	month,
	items,
	t,
	locale,
	now,
	onPickDay,
}: {
	readonly month: Date;
	readonly items: readonly AgendaListItem[];
	readonly t: AgendaMessages;
	readonly locale: string;
	readonly now: number;
	readonly onPickDay: (day: Date) => void;
}) {
	const days = monthGridDays(month);
	const byDay = new Map<string, AgendaListItem[]>();
	for (const a of [...items].sort(
		(x, y) => asDate(x.startsAt).getTime() - asDate(y.startsAt).getTime(),
	)) {
		const key = dayKey(asDate(a.startsAt));
		byDay.set(key, [...(byDay.get(key) ?? []), a]);
	}
	const todayKey = dayKey(new Date(now));

	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card">
			<div className="grid grid-cols-7 border-b border-border">
				{days.slice(0, 7).map((day) => (
					<div
						key={dayKey(day)}
						className="px-2 py-2 text-center text-xs font-semibold text-muted-foreground uppercase"
					>
						<LocalDateTime value={day} locale={locale} options={{ weekday: "short" }} />
					</div>
				))}
			</div>
			<div className="grid grid-cols-7">
				{days.map((day) => {
					const key = dayKey(day);
					const dayItems = byDay.get(key) ?? [];
					const inMonth = day.getMonth() === month.getMonth();
					const today = key === todayKey;
					return (
						<button
							key={key}
							type="button"
							data-day={key}
							onClick={() => onPickDay(day)}
							className={`flex min-h-24 flex-col gap-1 border-t border-l border-border p-1.5 text-left hover:bg-primary/5 [&:nth-child(7n+1)]:border-l-0 ${
								inMonth ? "" : "bg-muted/40 text-muted-foreground"
							}`}
						>
							<span
								className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold ${
									today ? "bg-primary text-primary-foreground" : ""
								}`}
							>
								{day.getDate()}
							</span>
							{dayItems.slice(0, MONTH_CELL_MAX).map((a) => (
								<span
									key={a.id}
									className={`truncate rounded px-1 text-[11px] ring-1 ${blockTone(a.status)} ${
										isLive(a.status) ? "" : "line-through opacity-60"
									}`}
								>
									<span className="font-mono">{hhmm(asDate(a.startsAt))}</span>{" "}
									{patientLabel(a.patientName, a.patientId, t)}
								</span>
							))}
							{dayItems.length > MONTH_CELL_MAX ? (
								<span className="text-[11px] text-muted-foreground">
									{t.moreCount(dayItems.length - MONTH_CELL_MAX)}
								</span>
							) : null}
						</button>
					);
				})}
			</div>
		</div>
	);
}
