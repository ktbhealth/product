import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EMAIL_OUTBOX_KIND, Email, EmailMessageSchema, EmailSendError } from "@ktb/email";
import { registerOutboxDeliverer } from "@ktb/outbox";

/**
 * Outbox edge wiring (@ktb/outbox): registers the kind deliverers the
 * drain sweep dispatches to. Today that is `email` — the payload is a
 * rendered {@link EmailMessage} (producers store the final copy, so
 * delivery never re-derives it) handed to the configured Email
 * sender. A disabled Email port fails the attempt honestly: the row
 * backs off and lands in terminal `failed`, visible in the outbox
 * table — never console.error'd away.
 *
 * Called once at module composition (lib/platform.ts) — deliverer
 * registration is process-global like `jobHandlers`.
 */
export const registerOutboxDeliverers = (
	run: <A, E>(effect: Effect.Effect<A, E, unknown>) => Promise<A>,
): void => {
	registerOutboxDeliverer(EMAIL_OUTBOX_KIND, async (payload) => {
		// Decode at the delivery edge — a corrupt payload is a failed
		// attempt like any other (backs off, then terminal `failed`).
		const message = Schema.decodeUnknownSync(EmailMessageSchema)(payload);
		const sender = await run(
			Effect.map(Effect.serviceOption(Email), (email) => Option.getOrNull(email)),
		);
		if (sender === null) {
			throw new EmailSendError("outbound email is disabled for this deployment");
		}
		await sender.send(message);
	});
};
