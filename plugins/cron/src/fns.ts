import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureSessionUser, runAs } from "@ktb/server-fns";

import { CronAdmin, type CronRunNowResult } from "./admin.ts";

// Cron console server function: admin manual trigger of a registered
// cron job. The service re-checks PlatformAdmin; Forbidden collapses
// to the same "forbidden" shape non-admins would get anyway (the
// /platform guard 404s them first).

const RunNowInput = Schema.Struct({
	id: Schema.NonEmptyString,
});
const decodeRunNowInput = Schema.decodeUnknownSync(RunNowInput);

export const runCronJobFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeRunNowInput(input))
	.handler(async ({ data }): Promise<CronRunNowResult> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const admin = yield* CronAdmin;
				return yield* admin.runNow(data.id);
			}).pipe(
				Effect.catchTag("Forbidden", () =>
					Effect.succeed<CronRunNowResult>({ ok: false, reason: "forbidden" }),
				),
			),
		);
	});
