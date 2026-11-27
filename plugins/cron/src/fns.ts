import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { forbiddenTo, sessionHandler } from "@ktb/server-fns";

import {
	CronAdmin,
	type CronRunNowResult,
	type ScheduleDeleteResult,
	type ScheduleWriteResult,
} from "./admin.ts";

// Cron console server functions: admin manual trigger of a registered
// cron job plus the runtime scheduler mutations (scheduled_jobs).
// Every service call re-checks PlatformAdmin; Forbidden collapses to
// the same "forbidden" shape non-admins would get anyway (the
// /platform guard 404s them first).

const RunNowInput = Schema.Struct({
	id: Schema.NonEmptyString,
});
const decodeRunNowInput = Schema.decodeUnknownSync(RunNowInput);

export const runCronJobFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunNowInput(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<CronRunNowResult> => {
			return run(
				Effect.gen(function* () {
					const admin = yield* CronAdmin;
					return yield* admin.runNow(data.id);
				}).pipe(
					Effect.catchTag("Forbidden", () =>
						Effect.succeed<CronRunNowResult>({ ok: false, reason: "forbidden" }),
					),
				),
			);
		}),
	);

// --- runtime scheduler (scheduled_jobs) ---------------------------------

const ScheduleStatus = Schema.Literals(["active", "paused", "done"]);

const CreateScheduleInput = Schema.Struct({
	kind: Schema.NonEmptyString,
	params: Schema.optionalKey(Schema.Unknown),
	cronExpr: Schema.optionalKey(Schema.NullOr(Schema.String)),
	runAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	// TenantId is string | number (@ktb/tenant) — wire input may carry
	// either form; the scheduler port normalizes to the integer column.
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
});
const decodeCreateScheduleInput = Schema.decodeUnknownSync(CreateScheduleInput);

const UpdateScheduleInput = Schema.Struct({
	id: Schema.NonEmptyString,
	patch: Schema.Struct({
		params: Schema.optionalKey(Schema.Unknown),
		cronExpr: Schema.optionalKey(Schema.NullOr(Schema.String)),
		runAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		status: Schema.optionalKey(ScheduleStatus),
	}),
});
const decodeUpdateScheduleInput = Schema.decodeUnknownSync(UpdateScheduleInput);

const DeleteScheduleInput = Schema.Struct({
	id: Schema.NonEmptyString,
});
const decodeDeleteScheduleInput = Schema.decodeUnknownSync(DeleteScheduleInput);

const forbiddenWrite = (): ScheduleWriteResult => ({ ok: false, reason: "unavailable" });

export const createScheduleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeCreateScheduleInput(input))
	.handler(
		sessionHandler(async ({ data, user, run }): Promise<ScheduleWriteResult> => {
			return run(
				Effect.gen(function* () {
					const admin = yield* CronAdmin;
					return yield* admin.createSchedule({ ...data, createdBy: user.id });
				}).pipe(forbiddenTo(forbiddenWrite())),
			);
		}),
	);

export const updateScheduleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeUpdateScheduleInput(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<ScheduleWriteResult> => {
			return run(
				Effect.gen(function* () {
					const admin = yield* CronAdmin;
					return yield* admin.updateSchedule(data.id, data.patch);
				}).pipe(forbiddenTo(forbiddenWrite())),
			);
		}),
	);

export const deleteScheduleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeDeleteScheduleInput(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<ScheduleDeleteResult> => {
			return run(
				Effect.gen(function* () {
					const admin = yield* CronAdmin;
					return yield* admin.deleteSchedule(data.id);
				}).pipe(
					Effect.catchTag("Forbidden", () =>
						Effect.succeed<ScheduleDeleteResult>({ ok: false, reason: "unavailable" }),
					),
				),
			);
		}),
	);

export const runScheduleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunNowInput(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<CronRunNowResult> => {
			return run(
				Effect.gen(function* () {
					const admin = yield* CronAdmin;
					return yield* admin.runScheduleNow(data.id);
				}).pipe(
					Effect.catchTag("Forbidden", () =>
						Effect.succeed<CronRunNowResult>({ ok: false, reason: "forbidden" }),
					),
				),
			);
		}),
	);
