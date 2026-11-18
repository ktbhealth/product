/**
 * Job-kind registrations for the local jobs worker (P-098 B2).
 *
 * The shared `jobHandlers` registry (@ktb/jobs-port) is populated at
 * composition time — domain packages self-register on import, and
 * app-bound kinds are wired here. Today the only built-in is the ops
 * `jobs.ping` smoke kind; the eval runner registers `eval.run` when
 * the in-platform eval lands.
 */

import { registerJobHandler } from "@ktb/jobs-port";

let registered = false;

export const registerWorkerHandlers = (): void => {
	if (registered) return;
	registered = true;
	registerJobHandler("jobs.ping", {
		handle: async () => {},
	});
};
