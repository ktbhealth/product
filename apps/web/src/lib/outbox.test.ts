import { describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";

import { makeTestDb } from "@ktb/db-testing";
import { Email, type EmailSender } from "@ktb/email";
import { drainOutbox, getOutboxRecord, insertOutboxRecord } from "@ktb/outbox";

import { registerOutboxDeliverers } from "./outbox.ts";

// The deliverer resolves the Email service per delivery through the
// app runtime — the fake `run` provides whichever sender the test
// bound (null = email disabled, like the nullEmailDriver).
let sender: EmailSender | null = null;
const run = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
	Effect.runPromise(
		(effect as Effect.Effect<A, E, Email>).pipe(Effect.provideService(Email, sender)),
	);

registerOutboxDeliverers(run);

const T0 = 1_700_000_000_000;
const message = { to: "a@ktb.test", subject: "Hi", text: "Body" };

describe("email outbox deliverer", () => {
	it("delivers a queued EmailMessage through the configured sender", async () => {
		const send = vi.fn(async () => {});
		sender = { send };
		const { db, close } = makeTestDb();
		try {
			const record = await insertOutboxRecord(db, { kind: "email", payload: message }, T0);
			const result = await drainOutbox(db, { now: T0 + 1 });
			expect(result).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
			expect(send).toHaveBeenCalledWith(message);
			expect(await getOutboxRecord(db, record.id)).toMatchObject({
				status: "done",
				error: null,
			});
		} finally {
			close();
		}
	});

	it("backs off and records the error when the provider refuses", async () => {
		sender = {
			send: async () => {
				throw new Error("provider down");
			},
		};
		const { db, close } = makeTestDb();
		try {
			const record = await insertOutboxRecord(db, { kind: "email", payload: message }, T0);
			const result = await drainOutbox(db, { now: T0 + 1 });
			expect(result).toMatchObject({ claimed: 1, delivered: 0, failed: 1, dead: 0 });
			expect(await getOutboxRecord(db, record.id)).toMatchObject({
				status: "pending",
				attempts: 1,
				error: "provider down",
			});
		} finally {
			close();
		}
	});

	it("fails the attempt when outbound email is disabled", async () => {
		sender = null;
		const { db, close } = makeTestDb();
		try {
			const record = await insertOutboxRecord(db, { kind: "email", payload: message }, T0);
			await drainOutbox(db, { now: T0 + 1 });
			expect(await getOutboxRecord(db, record.id)).toMatchObject({
				status: "pending",
				attempts: 1,
				error: "outbound email is disabled for this deployment",
			});
		} finally {
			close();
		}
	});

	it("counts a corrupt payload as a failed attempt", async () => {
		const send = vi.fn(async () => {});
		sender = { send };
		const { db, close } = makeTestDb();
		try {
			const record = await insertOutboxRecord(db, { kind: "email", payload: { to: 1 } }, T0);
			await drainOutbox(db, { now: T0 + 1 });
			expect(send).not.toHaveBeenCalled();
			const stored = await getOutboxRecord(db, record.id);
			expect(stored?.status).toBe("pending");
			expect(stored?.attempts).toBe(1);
		} finally {
			close();
		}
	});
});
