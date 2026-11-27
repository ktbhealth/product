/**
 * Local jobs worker loop (P-098 B2) — transport-agnostic pump: pull a
 * batch, hand it to the kind-dispatched consumer, repeat. Transport
 * errors back off briefly instead of hot-looping; shutdown is driven
 * by the AbortSignal so SIGINT drains cleanly.
 */

import type { DbClient } from "@ktb/db";
import { makeJobConsumer, type JobHandlers, type JobMessageLike } from "@ktb/jobs-port";

export interface JobWorkerTransport {
	readonly receive: (count?: number) => Promise<readonly JobMessageLike[]>;
}

export interface JobWorkerOptions {
	readonly transport: JobWorkerTransport;
	readonly handlers: JobHandlers;
	/** Optional job_runs projection — absent means status stays
	 * transport-side only (fine for local dev). */
	readonly db?: DbClient;
	/** Messages per poll — default 10. */
	readonly batchSize?: number;
	/** Backoff after a transport error ms — default 1000. */
	readonly errorBackoffMs?: number;
	/** Pause after an empty poll ms — default 100. Blocking transports
	 * (BRPOP) already wait server-side; this only guards against
	 * hot-spinning on instantly-empty transports. */
	readonly idleMs?: number;
	readonly signal?: AbortSignal;
	readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Fallback logger — worker call sites always pass `meta`. */
const defaultLog = (msg: string, meta?: Record<string, unknown>) => {
	/* v8 ignore next -- meta is always provided by runJobWorker call sites */
	console.log(msg, meta ?? "");
};

export const runJobWorker = async (opts: JobWorkerOptions): Promise<void> => {
	const consumer = makeJobConsumer({ handlers: opts.handlers, db: opts.db });
	const batchSize = opts.batchSize ?? 10;
	const backoffMs = opts.errorBackoffMs ?? 1_000;
	const idleMs = opts.idleMs ?? 100;
	const log = opts.log ?? defaultLog;
	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			const signal = opts.signal;
			const onAbort = () => {
				clearTimeout(t);
				resolve();
			};
			const t = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
		});

	while (opts.signal?.aborted !== true) {
		let messages: readonly JobMessageLike[];
		try {
			messages = await opts.transport.receive(batchSize);
		} catch (error) {
			log("jobs worker: transport error", { error: String(error) });
			await sleep(backoffMs);
			continue;
		}
		if (messages.length === 0) {
			await sleep(idleMs);
			continue;
		}
		try {
			await consumer(messages);
		} catch (error) {
			// makeJobConsumer handles per-message failures; a throw here is
			// a bug in the dispatch itself — log and keep the loop alive.
			log("jobs worker: consumer error", { error: String(error) });
		}
	}
};
