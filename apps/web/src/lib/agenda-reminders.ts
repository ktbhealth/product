import * as Effect from "effect/Effect";

import { Appointments } from "@ktb/agenda";
import { run } from "@ktb/server-fns";

/**
 * Agenda reminder sweep (P-008): the worker's `scheduled` handler
 * (src/server.ts) runs this on the five-minute cron — every pending
 * appointment entering its lead window gets claimed
 * (`reminderSentAt`) and an `appointment.reminderDue` domain event is
 * dispatched, which the notifications plugin projects into the
 * doctor's bell. Idempotent: the conditional claim update makes
 * repeat fires and concurrent sweeps no-ops.
 *
 * System path — no Principal: `Appointments.dispatchDueReminders` is
 * the service's documented system entry point (like the audit cron,
 * it runs against the composed runtime via server-fns `run`).
 * Failures are logged and swallowed — a broken sweep must never
 * crash the isolate or retry-storm.
 */

/** Structured log line — flat JSON like the http.access sink. */
const log = (level: "INFO" | "WARN" | "ERROR", message: string, fields: object): void => {
	const line = JSON.stringify({ message, level, ...fields });
	if (level === "ERROR") console.error(line);
	else if (level === "WARN") console.warn(line);
	else console.info(line);
};

export interface ScheduledAgendaReminderDeps {
	/** Injectable for tests — defaults to the composed-runtime sweep. */
	readonly dispatch?: () => Promise<number>;
}

/**
 * Run one reminder pass. Returns the number of reminders dispatched,
 * or `null` when the sweep itself threw (the error is already logged).
 */
export async function runScheduledAgendaReminders(
	deps: ScheduledAgendaReminderDeps = {},
): Promise<number | null> {
	const dispatch =
		deps.dispatch ??
		(() =>
			run(
				Effect.gen(function* () {
					const appointments = yield* Appointments;
					return yield* appointments.dispatchDueReminders();
				}),
			));
	try {
		const count = await dispatch();
		if (count > 0) log("INFO", "agenda.reminders.dispatched", { count });
		return count;
	} catch (error) {
		log("ERROR", "agenda.reminders.failed", { error: String(error) });
		return null;
	}
}
