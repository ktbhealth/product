/**
 * @ktb/jobs-transport-redis — the local-dev jobs transport (P-098 B1).
 *
 * Redis-list stand-in for the Cloudflare Queue binding: producers
 * `LPUSH` wire envelopes, consumers `BLMOVE` them onto a pending list
 * and hand batches to `makeJobConsumer` from @ktb/jobs-port — the same
 * kind-dispatched contract the worker queue delivers in production.
 *
 * Delivery semantics: at-least-once, including worker crashes. The pop
 * is not destructive — `BLMOVE` parks the raw envelope on
 * `<queue>:pending` atomically with the dequeue, `ack()` removes it
 * (`LREM`) and `retry()` re-pushes it onto the queue head first, then
 * clears the pending copy. A SIGKILL/OOM/reboot mid-handle leaves the
 * envelope on the pending list; the consumer calls `requeuePending()`
 * once at startup to drain stale entries back onto the queue, so the
 * job is redelivered and its `job_runs` row unsticks from
 * "processing". There is no broker-side attempt counter — poison jobs
 * are bounded by the job_runs projection and handler idempotency, same
 * trust model as the dev:node SQLite queue.
 *
 * Single-consumer assumption: `requeuePending()` is only safe at boot
 * before `receive()` starts — a second live consumer's in-flight
 * entries would be stolen. That matches the dev topology (one
 * apps/jobs-worker per Redis); the web app's stats-only transport
 * never calls it.
 *
 * Adapter package — Node Redis client at the edge; ports and plugins
 * never import it (wired by apps/jobs-worker and dev composition).
 */

import { createClient, type RedisClientType } from "redis";

import type { JobEnvelope, JobMessageLike } from "@ktb/jobs-port";
import type { QueueDepthStats } from "@ktb/queues-port";

/** Minimal client surface the transport needs — injectable for tests. */
export interface RedisLike {
	lPush(key: string, value: string): Promise<unknown>;
	blMove(
		source: string,
		destination: string,
		sourceSide: "LEFT" | "RIGHT",
		destinationSide: "LEFT" | "RIGHT",
		timeoutSeconds: number,
	): Promise<string | null>;
	lMove(
		source: string,
		destination: string,
		sourceSide: "LEFT" | "RIGHT",
		destinationSide: "LEFT" | "RIGHT",
	): Promise<string | null>;
	lRem(key: string, count: number, value: string): Promise<unknown>;
	lLen(key: string): Promise<number>;
	quit(): Promise<unknown>;
}

export interface RedisJobsTransportOptions {
	/** Redis URL — default `redis://127.0.0.1:6379`. */
	readonly url?: string;
	/** List key — default `ktb:jobs`. */
	readonly queue?: string;
	/** BLMOVE block seconds per poll — default 5. */
	readonly blockSeconds?: number;
	/** Test seam: supply a connected client instead of `url`. */
	readonly client?: RedisLike;
}

export interface RedisJobsTransport {
	/** JobsEnqueuer-compatible send — LPUSH the serialized envelope. */
	readonly send: (envelope: JobEnvelope) => Promise<void>;
	/** Move up to `count` envelopes onto the pending list as
	 * JobMessageLike batch (BLMOVE loop). */
	readonly receive: (count?: number) => Promise<readonly JobMessageLike[]>;
	/** Drain the pending list back onto the queue — call once at
	 * consumer startup so entries orphaned by a crashed/killed worker
	 * are redelivered. Returns the number requeued. Never call while
	 * another consumer may be mid-handle (see module doc). */
	readonly requeuePending: () => Promise<number>;
	/** Depth probe for the /platform queue registry: LLEN on the queue
	 * reports the pending backlog; LLEN on the pending list reports
	 * in-flight (popped, unacked) entries; done/failed have no
	 * broker-side meaning on a plain list — job_runs carries the
	 * lifecycle truth. */
	readonly stats: () => Promise<QueueDepthStats>;
	readonly close: () => Promise<void>;
}

const DEFAULT_URL = "redis://127.0.0.1:6379";
const DEFAULT_QUEUE = "ktb:jobs";
// Once the first message is in hand, batch-fill pops only wait briefly
// for more — a partial batch must dispatch immediately, not stall for
// the full blockSeconds before the consumer ever sees it.
const BATCH_FILL_BLOCK_SECONDS = 0.1;

export const createRedisJobsTransport = async (
	opts: RedisJobsTransportOptions = {},
): Promise<RedisJobsTransport> => {
	const queue = opts.queue ?? DEFAULT_QUEUE;
	const pending = `${queue}:pending`;
	const blockSeconds = opts.blockSeconds ?? 5;
	const client: RedisLike =
		opts.client ??
		(await (async () => {
			const c = createClient({ url: opts.url ?? DEFAULT_URL }) as RedisClientType;
			await c.connect();
			return c as unknown as RedisLike;
		})());

	const send = async (envelope: JobEnvelope): Promise<void> => {
		await client.lPush(queue, JSON.stringify(envelope));
	};

	const receive = async (count = 1): Promise<readonly JobMessageLike[]> => {
		const messages: JobMessageLike[] = [];
		for (let i = 0; i < count; i++) {
			const timeout = messages.length === 0 ? blockSeconds : BATCH_FILL_BLOCK_SECONDS;
			const body = await client.blMove(queue, pending, "RIGHT", "LEFT", timeout);
			if (body === null) break;
			messages.push({
				body: safeParse(body),
				// ack clears the pending copy — the entry is already off
				// the queue, so a crash before ack leaves it requeueable.
				ack: () => {
					void client.lRem(pending, 1, body).catch(() => {});
				},
				retry: () => {
					// Re-push BEFORE clearing pending: a crash between the
					// two leaves the pending copy for the reaper, never
					// loses the job (at-least-once over exactly-once).
					void (async () => {
						await client.lPush(queue, body);
						await client.lRem(pending, 1, body);
					})().catch(() => {});
				},
			});
		}
		return messages;
	};

	const requeuePending = async (): Promise<number> => {
		let moved = 0;
		// Drain oldest-first: pending is LPUSHed at the head, so the
		// tail holds the earliest in-flight entries.
		for (;;) {
			const entry = await client.lMove(pending, queue, "RIGHT", "LEFT");
			if (entry === null) return moved;
			moved += 1;
		}
	};

	return {
		send,
		receive,
		requeuePending,
		stats: async () => {
			const [pendingCount, inflight] = await Promise.all([
				client.lLen(queue),
				client.lLen(pending),
			]);
			return { pending: pendingCount, processing: inflight, done: 0, failed: 0 };
		},
		close: async () => {
			await client.quit();
		},
	};
};

/** Malformed JSON surfaces as the raw string — the consumer's envelope
 * decoder marks it poison and acks, never retries. */
const safeParse = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};
