import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import { Schema } from "effect";

import { ensureDoctorUser, runAs } from "@ktb/server-fns";

import { APPOINTMENT_STATUSES, type AppointmentStatus } from "./schema.ts";
import type { Forbidden } from "@ktb/authz";

import {
	Appointments,
	type AppointmentConflict,
	type AppointmentListItem,
	type AppointmentRow,
} from "./service.ts";
import { MAX_LIST_RANGE_DAYS } from "./window.ts";

// Agenda plugin server functions: plugin-owned like the route modules —
// handlers reach the app runtime through @ktb/server-fns (no host
// imports). Every call runs as the acting doctor (`ensureDoctorUser` →
// `runAs` binds the doctor-resolved Principal, so a delegated secretary
// writes under the doctor's scope); the service enforces owner authz
// and denial collapses to `{ ok: false }`.

/** The wire may carry startsAt as an ISO string, epoch ms or a Date —
 * server fns tolerate coercions (see normalizePatientId in the host). */
const normalizeStartsAt = (input: unknown): unknown => {
	if (input === null || typeof input !== "object") return input;
	const o = { ...(input as Record<string, unknown>) };
	if (typeof o.startsAt === "string" || typeof o.startsAt === "number") {
		const d = new Date(o.startsAt);
		if (!Number.isNaN(d.getTime())) o.startsAt = d;
		else delete o.startsAt;
	}
	return o;
};

const CreateInput = Schema.Struct({
	patientId: Schema.Number,
	startsAt: Schema.Date,
	durationMin: Schema.optionalKey(Schema.Number),
	note: Schema.optionalKey(Schema.NullishOr(Schema.String)),
});

const UpdateInput = Schema.Struct({
	id: Schema.Number,
	patientId: Schema.optionalKey(Schema.Number),
	startsAt: Schema.optionalKey(Schema.Date),
	durationMin: Schema.optionalKey(Schema.Number),
	note: Schema.optionalKey(Schema.NullishOr(Schema.String)),
});

const StatusInput = Schema.Struct({
	id: Schema.Number,
	status: Schema.Literals([...APPOINTMENT_STATUSES]),
});

const IdInput = Schema.Struct({ id: Schema.Number });

/** `from`/`to` arrive as ISO strings or epoch ms over the wire. */
const normalizeRange = (input: unknown): unknown => {
	if (input === null || typeof input !== "object") return input;
	const o = { ...(input as Record<string, unknown>) };
	for (const key of ["from", "to"] as const) {
		if (typeof o[key] === "string" || typeof o[key] === "number") o[key] = new Date(o[key]);
	}
	return o;
};

const RangeInput = Schema.Struct({ from: Schema.Date, to: Schema.Date });

export type ListAppointmentsFnResult =
	| { readonly ok: true; readonly appointments: readonly AppointmentListItem[] }
	| { readonly ok: false };

/**
 * Appointments in [from, to] for calendar ranges outside the loader
 * window (T-259) — month grids, far-off weeks. Inverted or wider than
 * MAX_LIST_RANGE_DAYS ranges are refused rather than clamped.
 */
export const listAppointmentsFn = createServerFn({ method: "GET" })
	.validator((input: unknown) => Schema.decodeUnknownSync(RangeInput)(normalizeRange(input)))
	.handler(async ({ data }): Promise<ListAppointmentsFnResult> => {
		const span = data.to.getTime() - data.from.getTime();
		if (span < 0 || span > MAX_LIST_RANGE_DAYS * 86_400_000) return { ok: false };
		const user = await ensureDoctorUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const appointments = yield* Appointments;
				const rows = yield* appointments.list(user.id, data);
				return { ok: true, appointments: rows } as const;
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false } as const))),
		);
	});

export type AppointmentFnResult =
	| { readonly ok: true; readonly appointment: AppointmentRow }
	| { readonly ok: false; readonly reason?: "conflict"; readonly conflictingId?: number };

const asResult = (row: AppointmentRow | null): AppointmentFnResult =>
	row === null ? { ok: false } : { ok: true, appointment: row };

/** Write denials collapse to `{ ok: false }`; a double-booking keeps its
 * reason so the form can say why instead of a generic failure. */
const collapseWriteErrors = <R>(
	effect: Effect.Effect<AppointmentFnResult, Forbidden | AppointmentConflict, R>,
) =>
	effect.pipe(
		Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false } as const)),
		Effect.catchTag("AppointmentConflict", (e) =>
			Effect.succeed({ ok: false, reason: "conflict", conflictingId: e.conflictingId } as const),
		),
	);

export const createAppointmentFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => Schema.decodeUnknownSync(CreateInput)(normalizeStartsAt(input)))
	.handler(async ({ data }) => {
		const user = await ensureDoctorUser();
		return runAs(
			user,
			collapseWriteErrors(
				Effect.gen(function* () {
					const appointments = yield* Appointments;
					const row = yield* appointments.create(user.id, data);
					return asResult(row);
				}),
			),
		);
	});

export const updateAppointmentFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => Schema.decodeUnknownSync(UpdateInput)(normalizeStartsAt(input)))
	.handler(async ({ data }) => {
		const user = await ensureDoctorUser();
		const { id, ...patch } = data;
		return runAs(
			user,
			collapseWriteErrors(
				Effect.gen(function* () {
					const appointments = yield* Appointments;
					const row = yield* appointments.update(user.id, id, patch);
					return asResult(row);
				}),
			),
		);
	});

export const setAppointmentStatusFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => Schema.decodeUnknownSync(StatusInput)(input))
	.handler(async ({ data }) => {
		const user = await ensureDoctorUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const appointments = yield* Appointments;
				const row = yield* appointments.setStatus(
					user.id,
					data.id,
					data.status as AppointmentStatus,
				);
				return asResult(row);
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false } as const))),
		);
	});

export type StartAppointmentFnResult =
	| { readonly ok: true; readonly consultationId: number }
	| { readonly ok: false };

/**
 * Open the appointment's consultation record — creates it on first call
 * (`source: "agenda"`, live) and returns its id so the client navigates
 * to the record page. Idempotent for already-linked appointments.
 */
export const startAppointmentFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => Schema.decodeUnknownSync(IdInput)(input))
	.handler(async ({ data }) => {
		const user = await ensureDoctorUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const appointments = yield* Appointments;
				const result = yield* appointments.start(user.id, data.id);
				return result === null
					? ({ ok: false } as const)
					: ({ ok: true, consultationId: result.consultationId } as const);
			}).pipe(Effect.catchTag("Forbidden", () => Effect.succeed({ ok: false } as const))),
		);
	});
