import * as Schema from "effect/Schema";
import { Event } from "@effect-server-utils/cqrs";

/**
 * Cross-plugin surface for agenda — events via `EventBus` (P-008).
 * The notifications plugin projects `AppointmentReminderDue` into
 * per-user console notifications; future calendar adapters project the
 * lifecycle events into external pushes.
 */

export const AppointmentScheduled = Event.make("appointment.scheduled", {
	id: Schema.Number,
	ownerId: Schema.String,
	patientId: Schema.Number,
	startsAt: Schema.Date,
	/** Owning tenant (`groups.id`) or null for personal rows — optional so
	 * pre-tenancy dispatches/tests stay valid; subscribers treat a missing
	 * value as personal scope. */
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

/** Any owner edit — including reschedule (startsAt moved, reminder
 * re-armed). External adapters re-push on this. */
export const AppointmentUpdated = Event.make("appointment.updated", {
	id: Schema.Number,
	ownerId: Schema.String,
	startsAt: Schema.Date,
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

export const AppointmentCancelled = Event.make("appointment.cancelled", {
	id: Schema.Number,
	ownerId: Schema.String,
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});

/**
 * Fired by the reminder sweep when an appointment enters its lead
 * window. `patientName` mirrors the PatientCreated precedent — under ZK
 * it is the stored envelope and subscribers must drop it (the
 * notifications map resolves the tenant's zk flag before writing
 * bodies).
 */
export const AppointmentReminderDue = Event.make("appointment.reminderDue", {
	id: Schema.Number,
	ownerId: Schema.String,
	patientName: Schema.NullOr(Schema.String),
	startsAt: Schema.Date,
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
