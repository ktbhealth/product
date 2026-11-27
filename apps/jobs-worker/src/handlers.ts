/**
 * Job-kind registrations for the local jobs worker (P-098 B2).
 *
 * The worker's job-handler registry (@ktb/jobs-port
 * `makeJobHandlerRegistry`) is built at composition time in main.ts —
 * this module only contributes the ops `jobs.ping` smoke kind.
 * Sibling modules own their kinds (orchestration.ts owns
 * `orchestrator.step`). The worker composes no plugins, so kinds like
 * `eval.run` stay unregistered here and degrade to "unknown job kind".
 */

import type { JobHandlerRegistry } from "@ktb/jobs-port";

export const registerWorkerHandlers = (registry: JobHandlerRegistry): void => {
	registry.register("jobs.ping", {
		handle: async () => {},
	});
};
