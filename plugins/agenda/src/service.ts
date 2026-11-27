import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
	and,
	asc,
	eq,
	gt,
	gte,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	or,
	inArray,
	sql,
	type SQL,
} from "drizzle-orm";

import { EventBus, Query } from "@effect-server-utils/cqrs";
import { Forbidden, Principal, requirePrincipalUser } from "@ktb/authz";
import { Permissions } from "@ktb/rbac";
import { Option } from "effect";
import { Consultations } from "@ktb/consultations";
import { Db, type DbClient } from "@ktb/db";
import { appointments, patients } from "@ktb/db/schema";
import { PatientsQueries } from "@ktb/patients/api";
import { accessibleTenantIds, Tenant, tenantScopeCondition, tenantScopeId } from "@ktb/tenant";

import {
	AppointmentCancelled,
	AppointmentReminderDue,
	AppointmentScheduled,
	AppointmentUpdated,
} from "./api.ts";
import { APPOINTMENT_TRANSITIONS, type AppointmentStatus } from "./schema.ts";

export type AppointmentRow = typeof appointments.$inferSelect;

/** Appointment row joined with the patient's display name (the stored
 * value — a `v1.` envelope under ZK, like every patient-name read). */
export interface AppointmentListItem extends AppointmentRow {
	readonly patientName: string | null;
}

/** Validated create input — dates arrive decoded, defaults applied. */
export interface AppointmentInput {
	readonly patientId: number;
	readonly startsAt: Date;
	readonly durationMin?: number;
	readonly note?: string | null;
}

/** Owner edit — every key optional; only the listed fields may move. */
export interface AppointmentPatch {
	readonly patientId?: number;
	readonly startsAt?: Date;
	readonly durationMin?: number;
	readonly note?: string | null;
}

/**
 * The owner already has a live appointment overlapping the requested
 * slot (P-119-A). Carries the clashing row id so the view can point at
 * it; a double-booking is a logistics error, never a silent write.
 */
export class AppointmentConflict extends Data.TaggedError("AppointmentConflict")<{
	readonly conflictingId: number;
}> {}

/** Statuses that occupy their slot — terminal rows free it. */
const SLOT_HOLDING_STATUSES = ["scheduled", "confirmed"] as const;

export const DEFAULT_DURATION_MIN = 30;
/** "About to start" lead window — the v1 fixed lead (15 min). */
export const REMINDER_LEAD_MS = 15 * 60 * 1000;

/**
 * Tenant visibility fence (P-053-B), same contract as
 * `patientScope` (@ktb/patients): a row is visible when the
 * `tenantScopeCondition` fence admits it AND it is either a personal
 * row the caller owns or a tenant-owned row (membership already proved
 * by the fence). Personal scope degrades to "own rows only".
 */
export const appointmentScope = (ownerId: string) =>
	Effect.map(tenantScopeCondition(appointments), (fence) =>
		and(fence, or(eq(appointments.ownerId, ownerId), isNotNull(appointments.tenantId))),
	);

/** True when `tenantId` is in the caller's accessible tenant set. */
const tenantRowVisible = (tenantId: number) =>
	Effect.map(accessibleTenantIds, (ids) => ids.some((id) => Number(id) === tenantId));

/**
 * Row-level authz — tenant-owned rows are governed by membership (any
 * member of the row's tenant may operate it; `ownerId` stays creator
 * attribution), personal rows require the bound principal to be the
 * owner. A secretary acting as the doctor binds the doctor's userId,
 * so delegated access passes through unchanged.
 */
const authorizeAppointmentRow = (
	row: { readonly ownerId: string; readonly tenantId: number | null },
	action: string,
) =>
	Effect.gen(function* () {
		if (row.tenantId !== null) {
			if (yield* tenantRowVisible(row.tenantId)) return;
			return yield* Effect.fail(new Forbidden({ path: action }));
		}
		yield* requirePrincipalUser(row.ownerId, action);
	});

// ---------- repo (plain async fns; authz lives in the service) ----------

export async function listAppointments(
	db: DbClient,
	scope: SQL | undefined,
	from: Date,
	to: Date,
): Promise<AppointmentListItem[]> {
	const rows = await db
		.select({ appointment: appointments, patientName: patients.name })
		.from(appointments)
		.leftJoin(patients, eq(appointments.patientId, patients.id))
		.where(and(scope, gte(appointments.startsAt, from), lte(appointments.startsAt, to)))
		.orderBy(asc(appointments.startsAt));
	return rows.map(({ appointment, patientName }) => ({ ...appointment, patientName }));
}

export async function getAppointment(db: DbClient, id: number): Promise<AppointmentRow | null> {
	const rows = await db.select().from(appointments).where(eq(appointments.id, id)).limit(1);
	return rows[0] ?? null;
}

export async function createAppointment(
	db: DbClient,
	values: {
		readonly ownerId: string;
		readonly patientId: number;
		readonly tenantId: number | null;
		readonly startsAt: Date;
		readonly durationMin: number;
		readonly note?: string | null;
	},
): Promise<AppointmentRow | null> {
	const rows = await db
		.insert(appointments)
		.values({ ...values, note: values.note ?? null, createdAt: new Date() })
		.returning();
	return rows[0] ?? null;
}

export async function updateAppointment(
	db: DbClient,
	id: number,
	patch: Partial<{
		patientId: number;
		startsAt: Date;
		durationMin: number;
		note: string | null;
		status: string;
		consultationId: number;
		reminderSentAt: Date | null;
	}>,
): Promise<AppointmentRow | null> {
	const rows = await db.update(appointments).set(patch).where(eq(appointments.id, id)).returning();
	return rows[0] ?? null;
}

/**
 * First live appointment of `ownerId` overlapping [startsAt, startsAt +
 * durationMin) — half-open, so back-to-back slots do not clash.
 * Per-owner on purpose: in a clinic tenant two doctors may see patients
 * at the same time. `excludeId` skips the row being edited.
 */
export async function findOverlappingAppointment(
	db: DbClient,
	ownerId: string,
	startsAt: Date,
	durationMin: number,
	excludeId?: number,
): Promise<AppointmentRow | null> {
	const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
	const rows = await db
		.select()
		.from(appointments)
		.where(
			and(
				eq(appointments.ownerId, ownerId),
				inArray(appointments.status, [...SLOT_HOLDING_STATUSES]),
				lt(appointments.startsAt, endsAt),
				gt(sql`${appointments.startsAt} + ${appointments.durationMin} * 60000`, startsAt.getTime()),
				excludeId === undefined ? undefined : ne(appointments.id, excludeId),
			),
		)
		.orderBy(asc(appointments.startsAt))
		.limit(1);
	return rows[0] ?? null;
}

/** Rows whose reminder should fire now: live statuses, not yet sent,
 * entering the lead window but not so far past it that "about to
 * start" reads wrong (a missed sweep stays missed — a stale
 * notification is worse than none). */
export async function listDueAppointments(
	db: DbClient,
	now: Date,
	leadMs: number,
): Promise<AppointmentListItem[]> {
	const horizon = new Date(now.getTime() + leadMs);
	const stale = new Date(now.getTime() - leadMs);
	const rows = await db
		.select({ appointment: appointments, patientName: patients.name })
		.from(appointments)
		.leftJoin(patients, eq(appointments.patientId, patients.id))
		.where(
			and(
				inArray(appointments.status, ["scheduled", "confirmed"]),
				isNull(appointments.reminderSentAt),
				lte(appointments.startsAt, horizon),
				gte(appointments.startsAt, stale),
			),
		)
		.orderBy(asc(appointments.startsAt));
	return rows.map(({ appointment, patientName }) => ({ ...appointment, patientName }));
}

/**
 * Claim one pending reminder — the conditional update double-writes
 * nothing when two sweeps race: only the winner's update returns a row.
 */
export async function claimReminder(db: DbClient, id: number, now = new Date()): Promise<boolean> {
	const rows = await db
		.update(appointments)
		.set({ reminderSentAt: now })
		.where(and(eq(appointments.id, id), isNull(appointments.reminderSentAt)))
		.returning({ id: appointments.id });
	return rows.length > 0;
}

/**
 * Appointments domain port — Effect service, swappable in tests.
 *
 * Owner-facing methods enforce authorization against the request
 * `Principal` (@ktb/authz): `ownerId` must be the bound principal's
 * userId (a secretary acting as the doctor binds the doctor's id) and
 * tenant-owned rows admit any member of that tenant. With no principal
 * (system context) all owner methods fail `Forbidden`.
 * `dispatchDueReminders` is the documented exception — a SYSTEM path
 * for the cron sweep and the agenda-loader poke; it deliberately does
 * not consult the Principal, like `Patients.ownerOf`.
 */
export class Appointments extends Context.Service<
	Appointments,
	{
		readonly list: (
			ownerId: string,
			range: { readonly from: Date; readonly to: Date },
		) => Effect.Effect<AppointmentListItem[], Forbidden>;
		readonly get: (ownerId: string, id: number) => Effect.Effect<AppointmentRow | null, Forbidden>;
		/** Fails `AppointmentConflict` when the slot overlaps a live row. */
		readonly create: (
			ownerId: string,
			input: AppointmentInput,
		) => Effect.Effect<AppointmentRow | null, Forbidden | AppointmentConflict>;
		/** Re-checks overlap only when startsAt/durationMin move. */
		readonly update: (
			ownerId: string,
			id: number,
			patch: AppointmentPatch,
		) => Effect.Effect<AppointmentRow | null, Forbidden | AppointmentConflict>;
		readonly setStatus: (
			ownerId: string,
			id: number,
			status: AppointmentStatus,
		) => Effect.Effect<AppointmentRow | null, Forbidden>;
		/**
		 * Open the consultation for this appointment: creates the record
		 * (`source: "agenda"`, live) and links it. Idempotent — an
		 * already-linked appointment returns its record. Null when the
		 * appointment does not exist; Forbidden outside the owner scope.
		 */
		readonly start: (
			ownerId: string,
			id: number,
		) => Effect.Effect<{ appointment: AppointmentRow; consultationId: number } | null, Forbidden>;
		/**
		 * Reminder sweep (SYSTEM — no Principal): claims every pending
		 * appointment inside the lead window and dispatches
		 * `AppointmentReminderDue` per claimed row. Idempotent via the
		 * `reminderSentAt` claim; returns how many reminders fired.
		 */
		readonly dispatchDueReminders: (options?: {
			readonly now?: Date;
			readonly leadMs?: number;
		}) => Effect.Effect<number>;
	}
>()("@ktb/agenda/Appointments") {}

export const AppointmentsLive = Layer.effect(
	Appointments,
	Effect.gen(function* () {
		const db = yield* Db;
		const events = yield* EventBus;
		const patientQueries = yield* Query.dispatcher(PatientsQueries);
		const consultations = yield* Consultations;
		// Patient-link checks resolve owner tuples through the rbac
		// plugin's Permissions port — the optionalDeps edge orders
		// rbac.services first; absent → the check fails closed
		// (Forbidden), the same deny shape as an unbound principal.
		const permissionsOption = yield* Effect.serviceOption(Permissions);
		const permissions = Option.isSome(permissionsOption) ? permissionsOption.value : null;

		// Patient-link guard: a patientId must resolve to a patient the
		// acting principal may see — same contract as consultations'
		// requireOwnedPatient (tenant members link tenant patients,
		// personal patients pass the `owner` relation-tuple check).
		const requireOwnedPatient = (patientId: number, path: string) =>
			Effect.gen(function* () {
				const owner = yield* patientQueries["patients.ownerOf"]({ id: patientId });
				if (owner === null) return yield* Effect.fail(new Forbidden({ path }));
				if (owner.tenantId !== null) {
					if (!(yield* tenantRowVisible(owner.tenantId))) {
						return yield* Effect.fail(new Forbidden({ path }));
					}
					return;
				}
				if (permissions === null) {
					return yield* Effect.fail(new Forbidden({ path: `rbac.patient.${patientId}.owner` }));
				}
				yield* permissions.requireObject("patient", String(patientId), "owner");
			});

		const requireFreeSlot = (
			ownerId: string,
			startsAt: Date,
			durationMin: number,
			excludeId?: number,
		) =>
			Effect.gen(function* () {
				const clash = yield* Effect.promise(() =>
					findOverlappingAppointment(db, ownerId, startsAt, durationMin, excludeId),
				);
				if (clash !== null) {
					return yield* Effect.fail(new AppointmentConflict({ conflictingId: clash.id }));
				}
			});

		return Appointments.of({
			list: Effect.fn("Appointments.list")(function* (
				ownerId: string,
				range: { readonly from: Date; readonly to: Date },
			) {
				yield* requirePrincipalUser(ownerId, "appointment.read");
				const scope = yield* appointmentScope(ownerId);
				return yield* Effect.promise(() => listAppointments(db, scope, range.from, range.to));
			}),
			get: Effect.fn("Appointments.get")(function* (ownerId: string, id: number) {
				yield* requirePrincipalUser(ownerId, "appointment.read");
				const row = yield* Effect.promise(() => getAppointment(db, id));
				if (row === null) return null;
				yield* authorizeAppointmentRow(row, "appointment.read");
				return row;
			}),
			create: Effect.fn("Appointments.create")(function* (
				ownerId: string,
				input: AppointmentInput,
			) {
				yield* requirePrincipalUser(ownerId, "appointment.create");
				yield* requireOwnedPatient(input.patientId, "appointment.create");
				const durationMin = input.durationMin ?? DEFAULT_DURATION_MIN;
				yield* requireFreeSlot(ownerId, input.startsAt, durationMin);
				const tenant = yield* Tenant;
				const tenantId = tenantScopeId(tenant);
				yield* Effect.annotateCurrentSpan({ ownerId, patientId: input.patientId });
				const row = yield* Effect.promise(() =>
					createAppointment(db, {
						ownerId,
						patientId: input.patientId,
						tenantId,
						startsAt: input.startsAt,
						durationMin,
						note: input.note ?? null,
					}),
				);
				/* v8 ignore next -- the insert returns the row; null only on an FK-edge delete race */
				if (row !== null) {
					yield* events.dispatch([
						AppointmentScheduled.make({
							id: row.id,
							ownerId,
							patientId: row.patientId,
							startsAt: row.startsAt,
							tenantId,
						}),
					]);
				}
				return row;
			}),
			update: Effect.fn("Appointments.update")(function* (
				ownerId: string,
				id: number,
				patch: AppointmentPatch,
			) {
				yield* requirePrincipalUser(ownerId, "appointment.update");
				const row = yield* Effect.promise(() => getAppointment(db, id));
				if (row === null) return null;
				yield* authorizeAppointmentRow(row, "appointment.update");
				if (patch.patientId !== undefined) {
					yield* requireOwnedPatient(patch.patientId, "appointment.update");
				}
				// A reschedule re-arms the reminder — the new startsAt
				// deserves its own lead-window pass.
				const rescheduled =
					patch.startsAt !== undefined && patch.startsAt.getTime() !== row.startsAt.getTime();
				const resized = patch.durationMin !== undefined && patch.durationMin !== row.durationMin;
				// The slot is checked against the row's own owner — a tenant
				// member editing a colleague's appointment moves it within
				// the colleague's agenda.
				if (rescheduled || resized) {
					yield* requireFreeSlot(
						row.ownerId,
						patch.startsAt ?? row.startsAt,
						patch.durationMin ?? row.durationMin,
						id,
					);
				}
				const updated = yield* Effect.promise(() =>
					updateAppointment(db, id, {
						...(patch.patientId !== undefined ? { patientId: patch.patientId } : {}),
						...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
						...(patch.durationMin !== undefined ? { durationMin: patch.durationMin } : {}),
						...(patch.note !== undefined ? { note: patch.note } : {}),
						...(rescheduled ? { reminderSentAt: null } : {}),
					}),
				);
				/* v8 ignore next -- the update returns the row; null only on a mid-flight delete */
				if (updated !== null) {
					yield* events.dispatch([
						AppointmentUpdated.make({
							id,
							ownerId: row.ownerId,
							startsAt: updated.startsAt,
							tenantId: row.tenantId,
						}),
					]);
				}
				return updated;
			}),
			setStatus: Effect.fn("Appointments.setStatus")(function* (
				ownerId: string,
				id: number,
				status: AppointmentStatus,
			) {
				yield* requirePrincipalUser(ownerId, "appointment.update");
				const row = yield* Effect.promise(() => getAppointment(db, id));
				if (row === null) return null;
				yield* authorizeAppointmentRow(row, "appointment.update");
				if (!APPOINTMENT_TRANSITIONS[row.status as AppointmentStatus]?.includes(status)) {
					return yield* Effect.fail(new Forbidden({ path: "appointment.update" }));
				}
				const updated = yield* Effect.promise(() => updateAppointment(db, id, { status }));
				if (updated !== null && status === "cancelled") {
					yield* events.dispatch([
						AppointmentCancelled.make({ id, ownerId: row.ownerId, tenantId: row.tenantId }),
					]);
				}
				return updated;
			}),
			start: Effect.fn("Appointments.start")(function* (ownerId: string, id: number) {
				const principal = yield* Principal;
				if (principal === null || principal.userId !== ownerId) {
					return yield* Effect.fail(new Forbidden({ path: "appointment.update" }));
				}
				const row = yield* Effect.promise(() => getAppointment(db, id));
				if (row === null) return null;
				yield* authorizeAppointmentRow(row, "appointment.update");
				if (row.consultationId !== null) {
					return { appointment: row, consultationId: row.consultationId };
				}
				if (row.status !== "scheduled" && row.status !== "confirmed") {
					return yield* Effect.fail(new Forbidden({ path: "appointment.update" }));
				}
				// The record belongs to the acting doctor, not necessarily
				// the appointment owner — a tenant member covering a
				// colleague's slot consults under their own scope.
				const consultationId = yield* consultations.create({
					userId: principal.userId,
					patientId: row.patientId,
					source: "agenda",
					status: "live",
				});
				/* v8 ignore next -- consultations.create only returns null on an empty insert, which the FK-checked write cannot produce */
				if (consultationId === null) return null;
				const updated = yield* Effect.promise(() => updateAppointment(db, id, { consultationId }));
				/* v8 ignore next -- updateAppointment returns the row; ?? row only on a mid-flight delete */
				return { appointment: updated ?? row, consultationId };
			}),
			dispatchDueReminders: Effect.fn("Appointments.dispatchDueReminders")(function* (options?: {
				readonly now?: Date;
				readonly leadMs?: number;
			}) {
				const now = options?.now ?? new Date();
				const leadMs = options?.leadMs ?? REMINDER_LEAD_MS;
				const due = yield* Effect.promise(() => listDueAppointments(db, now, leadMs));
				let dispatched = 0;
				for (const row of due) {
					const claimed = yield* Effect.promise(() => claimReminder(db, row.id, now));
					if (!claimed) continue;
					yield* events.dispatch([
						AppointmentReminderDue.make({
							id: row.id,
							ownerId: row.ownerId,
							patientName: row.patientName,
							startsAt: row.startsAt,
							tenantId: row.tenantId,
						}),
					]);
					dispatched += 1;
				}
				return dispatched;
			}),
		});
	}),
);
