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
 *     Redis-consumed runs); JOBS_DB=off disables the projection.
 */

import { jobHandlers } from "@ktb/jobs-port";
import { createRedisJobsTransport } from "@ktb/jobs-transport-redis";

import { batchSizeFromEnv } from "./env.ts";
import { openWorkerDb } from "./db.ts";
import { registerWorkerHandlers } from "./handlers.ts";
import { runJobWorker } from "./worker.ts";

registerWorkerHandlers();

const transport = await createRedisJobsTransport({
	url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
	...(process.env.JOBS_QUEUE !== undefined ? { queue: process.env.JOBS_QUEUE } : {}),
});

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => ac.abort());
}

console.log("jobs worker: consuming", process.env.JOBS_QUEUE ?? "ktb:jobs");
try {
	await runJobWorker({
		transport,
		handlers: jobHandlers,
		db: openWorkerDb(),
		batchSize: batchSizeFromEnv(process.env.JOBS_BATCH),
		signal: ac.signal,
	});
} finally {
	await transport.close();
}
