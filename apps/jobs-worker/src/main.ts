#!/usr/bin/env bun
/**
 * ktb jobs worker — local-dev consumer for the Redis jobs transport
 * (P-098 B2). Production queue consumption stays in the Cloudflare
 * Worker (apps/web queue consumer); this process exists so `bun run
 * dev` + `docker compose up -d` gives a real enqueue→consume loop
 * across processes.
 *
 *   REDIS_URL=redis://localhost:6379 bun apps/jobs-worker/src/main.ts
 *
 * Env:
 *   REDIS_URL    — default redis://127.0.0.1:6379
 *   JOBS_QUEUE   — list key, default ktb:jobs (must match producers)
 *   JOBS_BATCH   — messages per poll, default 10
 *   DATABASE_URL — job_runs projection store (default: the dev:node app
 *     db at apps/web/data/app.db so the /platform queue console sees
 *     Redis-consumed runs); JOBS_DB=off disables the projection AND
 *     the orchestrator.step registration (durable runs need the
 *     orchestration_* tables in the same db).
 */

import { makeJobHandlerRegistry, makeJobs } from "@ktb/jobs-port";
import { createRedisJobsTransport } from "@ktb/jobs-transport-redis";

import { batchSizeFromEnv } from "./env.ts";
import { openWorkerDb } from "./db.ts";
import { registerWorkerHandlers } from "./handlers.ts";
import { makeOrchestrationWorker } from "./orchestration.ts";
import { runJobWorker } from "./worker.ts";

// Composition-built kind → handler registry: builtin kinds only —
// this process composes no plugins, so plugin-owned kinds (eval.run,
// …) stay unregistered and degrade to "unknown job kind".
const jobHandlerRegistry = makeJobHandlerRegistry();
registerWorkerHandlers(jobHandlerRegistry);

const transport = await createRedisJobsTransport({
	url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
	...(process.env.JOBS_QUEUE !== undefined ? { queue: process.env.JOBS_QUEUE } : {}),
});

const db = openWorkerDb();
if (db !== undefined) {
	// orchestrator.step re-enqueues itself through the same transport;
	// makeJobs also writes the job_runs projection rows the /platform
	// queue console reads. See orchestration.ts for the dev-mode gaps
	// (no plugin packs, registry-only ambientContext).
	const jobs = makeJobs({ send: (envelope) => transport.send(envelope), db });
	makeOrchestrationWorker({ db, jobs }).registerStepHandler(jobHandlerRegistry);
	console.log("jobs worker: orchestrator.step registered");
} else {
	console.log(
		"jobs worker: JOBS_DB=off — orchestrator.step not registered (durable runs need the orchestration_* tables)",
	);
}

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => ac.abort());
}

console.log("jobs worker: consuming", process.env.JOBS_QUEUE ?? "ktb:jobs");
// Recover envelopes orphaned on the pending list by a previous
// crash/kill — BLMOVE parks popped entries there until ack, so a dead
// worker's in-flight jobs would otherwise never redeliver.
try {
	const requeued = await transport.requeuePending();
	if (requeued > 0) {
		console.log(`jobs worker: requeued ${requeued} orphaned job(s) from pending list`);
	}
} catch (error) {
	// Non-fatal: receive() has its own transport-error backoff, and a
	// failed sweep just defers orphan recovery to the next boot.
	console.warn("jobs worker: pending-list sweep failed", { error: String(error) });
}
try {
	await runJobWorker({
		transport,
		handlers: jobHandlerRegistry.handlers(),
		db,
		batchSize: batchSizeFromEnv(process.env.JOBS_BATCH),
		signal: ac.signal,
	});
} finally {
	await transport.close();
}
