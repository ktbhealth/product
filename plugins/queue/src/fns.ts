import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureSessionUser, runAs } from "@ktb/server-fns";

import { QueueAdmin, type EnqueueJobResult } from "./admin.ts";

// Queue console server function: admin test-enqueue of a job kind onto
// the bound transport. The service re-checks PlatformAdmin; Forbidden
// collapses to the same "forbidden" shape non-admins would get anyway
// (the /platform guard 404s them first).

const EnqueueInput = Schema.Struct({
	kind: Schema.NonEmptyString,
	payload: Schema.optionalKey(Schema.Unknown),
});
const decodeEnqueueInput = Schema.decodeUnknownSync(EnqueueInput);

export const enqueueJobFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodeEnqueueInput(input))
	.handler(async ({ data }): Promise<EnqueueJobResult> => {
		const user = await ensureSessionUser();
		return runAs(
			user,
			Effect.gen(function* () {
				const admin = yield* QueueAdmin;
				return yield* admin.enqueue(data.kind, data.payload);
			}).pipe(
				Effect.catchTag("Forbidden", () =>
					Effect.succeed<EnqueueJobResult>({ ok: false, reason: "forbidden" }),
				),
			),
		);
	});
