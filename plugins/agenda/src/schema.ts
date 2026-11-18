import { index, integer, sqliteTable, text, uniqueIndex } from "../../../packages/db/src/table.ts";

// Relative imports on purpose: drizzle-kit loads the composed schema
// through a CJS resolver that cannot follow `@ktb/*` package
// specifiers, and the generated packages/db/src/schema.gen.ts reaches
// plugin sources by relative path anyway — keep the FK targets on the
// same module resolution.
import { groups } from "../../groups/src/schema.ts";
import { patients } from "../../patients/src/schema.ts";
import { consultations } from "../../consultations/src/schema.ts";

/**
 * Appointment lifecycle — scheduling is logistics, not clinical state
 * (proposal-0008: no triage/urgency semantics). `scheduled` →
 * `confirmed` → `completed` | `no_show`; `cancelled` from any live
 * status. A row whose `consultationId` is set is in progress/done —
 * the consultation record carries the clinical half.
 */
export const APPOINTMENT_STATUSES = [
	"scheduled",
	"confirmed",
	"completed",
	"no_show",
	"cancelled",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Transitions the owner may apply — anything not listed is rejected. */
export const APPOINTMENT_TRANSITIONS: Readonly<
	Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
	scheduled: ["confirmed", "completed", "no_show", "cancelled"],
	confirmed: ["completed", "no_show", "cancelled"],
	completed: [],
	no_show: [],
	cancelled: [],
};

/**
 * External-calendar mirror state (P-008): `local` rows never left the
 * DB; `pending_push` has local changes awaiting the next sync pass;
 * `synced` matches the provider copy; `conflict` means the provider
 * changed underneath us — KTB never silently overwrites an external
 * event, conflicts resolve read-only until the doctor edits again.
 */
export const APPOINTMENT_SYNC_STATES = ["local", "pending_push", "synced", "conflict"] as const;
export type AppointmentSyncState = (typeof APPOINTMENT_SYNC_STATES)[number];

/**
 * Doctor agenda (P-008): every row is a consultation slot owned by a
 * doctor (`ownerId` = the doctor's `user.id` — same scoping convention
 * as `consultations.user_id`/`patients.owner_id`, so a secretary acting
 * as the doctor sees the same agenda through the bound Principal).
 * `patientId` is required — an appointment IS a scheduled consult, not
 * a generic calendar block.
 *
 * `tenantId` (P-053): NULL = personal row scoped by `ownerId`; a
 * `groups.id` = clinic-shared row. Same `sqliteTable` rationale as
 * patients — tenant fencing happens through `tenantScopeCondition` +
 * service authz. SET NULL keeps the row if the clinic group is deleted.
 *
 * `consultationId` links the consultation record created when the
 * doctor starts the visit — NULL until then; one appointment has at
 * most one record.
 *
 * `reminderSentAt` is the idempotency marker for the "about to start"
 * sweep — NULL arms the reminder; rescheduling clears it so a moved
 * appointment reminds at the new time.
 *
 * `external_*`/`syncState` are the Google-Calendar-ready seam: provider
 * id, calendar + event ids, etag and the per-row mirror state. All NULL/
 * `local` until a calendar adapter binds (see @ktb/calendar).
 *
 * `note` is administrative metadata only (logistics — "bring exams"),
 * never clinical content: it is stored plaintext and may be mirrored to
 * external calendars as the event description is always derived, never
 * copied from this field.
 */
export const appointments = sqliteTable(
	"appointments",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		ownerId: text("owner_id").notNull(),
		patientId: integer("patient_id")
			.notNull()
			.references(() => patients.id),
		tenantId: integer("tenant_id").references(() => groups.id, { onDelete: "set null" }),
		status: text().notNull().default("scheduled"),
		startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
		durationMin: integer("duration_min").notNull().default(30),
		consultationId: integer("consultation_id").references(() => consultations.id),
		note: text(),
		reminderSentAt: integer("reminder_sent_at", { mode: "timestamp_ms" }),
		externalProvider: text("external_provider"),
		externalCalendarId: text("external_calendar_id"),
		externalEventId: text("external_event_id"),
		externalEtag: text("external_etag"),
		syncState: text("sync_state").notNull().default("local"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		// Owner agenda reads and the due-reminder sweep's per-owner scans.
		index("appointments_owner_start_idx").on(table.ownerId, table.startsAt),
		// Sweep filter: reminderSentAt IS NULL AND startsAt <= horizon.
		index("appointments_reminder_idx").on(table.reminderSentAt, table.startsAt),
		index("appointments_tenant_id_idx").on(table.tenantId),
		index("appointments_patient_idx").on(table.patientId),
		// Sync dedup: one appointment per (provider, calendar, event).
		uniqueIndex("appointments_external_idx").on(
			table.externalProvider,
			table.externalCalendarId,
			table.externalEventId,
		),
	],
);

export type Appointment = typeof appointments.$inferSelect;
