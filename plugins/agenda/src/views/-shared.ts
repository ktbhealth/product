import { isEnvelope } from "@ktb/patients/zk";

import type { AgendaMessages } from "../i18n.ts";

// ---------- date helpers (local wall time — clinic-local scheduling) ----------

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Monday of d's week — the clinic week convention. */
export const weekStart = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
export const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const dayKey = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const hhmm = (d: Date) =>
	`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

// ---------- presentation ----------

export const STATUS_TONES: Record<string, string> = {
	scheduled: "bg-info/10 text-info ring-info/20",
	confirmed: "bg-success/10 text-success ring-success/20",
	completed: "bg-muted text-muted-foreground ring-border",
	no_show: "bg-warning/10 text-warning ring-warning/20",
	cancelled: "bg-destructive/10 text-destructive ring-destructive/20",
};

export const statusLabel = (t: AgendaMessages, status: string) =>
	({
		scheduled: t.status.scheduled,
		confirmed: t.status.confirmed,
		completed: t.status.completed,
		no_show: t.status.noShow,
		cancelled: t.status.cancelled,
	})[status] ?? status;

/** Statuses still occupying their slot — editable, startable. */
export const isLive = (status: string) => status === "scheduled" || status === "confirmed";

/** Display label for a patient: `v1.` envelopes (ZK tenant, no device
 * grant) render as the locked placeholder — never the raw ciphertext,
 * same locked-row contract as the patients list. */
export const patientLabel = (name: string | null, id: number, t: AgendaMessages) =>
	name === null ? `#${id}` : isEnvelope(name) ? t.zk.lockedName : name;
