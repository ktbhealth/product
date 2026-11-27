import { createServerFn } from "@tanstack/react-start";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sessionHandler } from "@ktb/server-fns";

import { PubSubAdmin, type PubSubPublishResult } from "./admin.ts";

// Pub/sub console server function: admin manual publish to a topic.
// The service re-checks PlatformAdmin; Forbidden collapses to the same
// "forbidden" shape non-admins would get anyway (the /platform guard
// 404s them first). The payload is Schema.Unknown — transports
// serialize it; the UI validates JSON before calling.

const PublishInput = Schema.Struct({
	topicId: Schema.NonEmptyString,
	payload: Schema.Unknown,
});
const decodePublishInput = Schema.decodeUnknownSync(PublishInput);

export const publishPubSubMessageFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => decodePublishInput(input))
	.handler(
		sessionHandler(async ({ data, run }): Promise<PubSubPublishResult> => {
			return run(
				Effect.gen(function* () {
					const admin = yield* PubSubAdmin;
					return yield* admin.publish(data.topicId, data.payload);
				}).pipe(
					Effect.catchTag("Forbidden", () =>
						Effect.succeed<PubSubPublishResult>({ ok: false, reason: "forbidden" }),
					),
				),
			);
		}),
	);
