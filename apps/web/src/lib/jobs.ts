import type { JobRegistration } from "@ktb/jobs-port";

/**
 * Kind → handler registry for the shared jobs queue consumer (PL-007).
 * The consumer in `audio-jobs.ts` dispatches every AUDIO_QUEUE message
 * through this map; `transcription.audio` is registered per-call with
 * the consumer's deps, everything else registers here at composition
 * time (future producers: theme assets, exporters).
 */
export const jobHandlers: Record<string, JobRegistration> = {};

/** Register (or replace) a job kind handler. Called once at app
 * composition by the owning edge module — never from request paths. */
export const registerJobHandler = (kind: string, registration: JobRegistration): void => {
	jobHandlers[kind] = registration;
};
