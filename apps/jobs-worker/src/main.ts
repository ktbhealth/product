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
 */

import { jobHandlers } from "@ktb/jobs-port";
import { createRedisJobsTransport } from "@ktb/jobs-transport-redis";

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
await runJobWorker({
	transport,
	handlers: jobHandlers,
	batchSize: process.env.JOBS_BATCH !== undefined ? Number(process.env.JOBS_BATCH) : 10,
	signal: ac.signal,
});
await transport.close();
