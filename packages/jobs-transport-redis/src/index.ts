/**
 * @ktb/jobs-transport-redis — the local-dev jobs transport (P-098 B1).
 *
 * Redis-list stand-in for the Cloudflare Queue binding: producers
 * `LPUSH` wire envelopes, consumers `BRPOP` them and hand batches to
 * `makeJobConsumer` from @ktb/jobs-port — the same kind-dispatched
 * contract the worker queue delivers in production.
 *
 * Delivery semantics: at-least-once. `ack()` is a no-op (the entry is
 * already popped); `retry()` re-pushes the envelope onto the head of
 * the list so it is delivered again on the next poll. There is no
 * broker-side attempt counter — poison jobs are bounded by the
 * job_runs projection and handler idempotency, same trust model as
 * the dev:node SQLite queue.
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
	brPop(key: string, timeoutSeconds: number): Promise<readonly [string, string] | null>;
	lLen(key: string): Promise<number>;
	quit(): Promise<unknown>;
	/** Hard socket teardown — optional on the injectable seam. */
	destroy?(): void;
}

export interface RedisJobsTransportOptions {
	/** Redis URL — default `redis://127.0.0.1:6379`. */
	readonly url?: string;
	/** List key — default `ktb:jobs`. */
	readonly queue?: string;
	/** BRPOP block seconds per poll — default 5. */
	readonly blockSeconds?: number;
	/** Test seam: supply a connected client instead of `url`. */
	readonly client?: RedisLike;
}

export interface RedisJobsTransport {
	/** JobsEnqueuer-compatible send — LPUSH the serialized envelope. */
	readonly send: (envelope: JobEnvelope) => Promise<void>;
	/** Pop up to `count` envelopes as JobMessageLike batch (BRPOP loop). */
	readonly receive: (count?: number) => Promise<readonly JobMessageLike[]>;
	/** Depth probe for the /platform queue registry: LLEN reports the
	 * pending backlog; processing/done/failed have no broker-side
	 * meaning on a plain list (BRPOP pops before handling), so they
	 * report 0 — job_runs carries the lifecycle truth. */
	readonly stats: () => Promise<QueueDepthStats>;
	readonly close: () => Promise<void>;
}

const DEFAULT_URL = "redis://127.0.0.1:6379";
const DEFAULT_QUEUE = "ktb:jobs";
// QUIT is queued through node-redis's offline command queue and only
// flushes once the socket reconnects — bound it so close() never hangs
// on an unreachable Redis, then destroy the socket outright.
const CLOSE_TIMEOUT_MS = 1000;
// Once the first message is in hand, batch-fill pops only wait briefly
// for more — a partial batch must dispatch immediately, not stall for
// the full blockSeconds before the consumer ever sees it.
const BATCH_FILL_BLOCK_SECONDS = 0.1;

export const createRedisJobsTransport = async (
	opts: RedisJobsTransportOptions = {},
): Promise<RedisJobsTransport> => {
	const queue = opts.queue ?? DEFAULT_QUEUE;
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
			const popped = await client.brPop(queue, timeout);
			if (popped === null) break;
			const body = popped[1];
			messages.push({
				body: safeParse(body),
				// Already popped — ack is a no-op; retry re-queues at head.
				ack: () => {},
				retry: () => {
					void client.lPush(queue, body).catch(() => {});
				},
			});
		}
		return messages;
	};

	return {
		send,
		receive,
		stats: async () => {
			const pending = await client.lLen(queue);
			return { pending, processing: 0, done: 0, failed: 0 };
		},
		close: async () => {
			const timer = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref());
			await Promise.race([client.quit().catch(() => {}), timer]);
			client.destroy?.();
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
