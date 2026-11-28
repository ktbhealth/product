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
 * (`LREM`) and `retry()` re-pushes it onto the queue tail (RPUSH) so it
 * is the next entry delivered, then clears the pending copy. A
 * SIGKILL/OOM/reboot mid-handle leaves the envelope on the pending
 * list; the consumer calls `requeuePending()` once at startup to drain
 * stale entries back onto the queue, so the job is redelivered and its
 * `job_runs` row unsticks from "processing". The delivery count rides
 * on the serialized envelope as an `attempts` field (ignored by the
 * wire decoder) and is reported as `message.attempts`, so the
 * consumer's `maxAttempts` ceiling actually binds — a poison job is
 * acked as exhausted instead of looping forever.
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

import type { JobMessageLike } from "@ktb/jobs-port";
import type { QueueDepthStats, QueueTransport } from "@ktb/queues-port";

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
	rPush(key: string, value: string): Promise<unknown>;
	lLen(key: string): Promise<number>;
	quit(): Promise<unknown>;
	/** Hard socket teardown — optional on the injectable seam. */
	destroy?(): void;
	/** Sorted-set + eval surface for delayed delivery (`runAt`
	 * envelopes park on `<queue>:delayed` until a sweeper moves them
	 * onto the list). Optional: a client without it degrades delayed
	 * sends to immediate LPUSH — early delivery beats a stalled job. */
	zAdd?(key: string, member: { score: number; value: string }): Promise<unknown>;
	zCard?(key: string): Promise<number>;
	eval?(
		script: string,
		options: { keys: readonly string[]; arguments: readonly string[] },
	): Promise<unknown>;
}

export interface RedisJobsTransportOptions {
	/** Redis URL — default `redis://127.0.0.1:6379`. */
	readonly url?: string;
	/** List key — default `ktb:jobs`. */
	readonly queue?: string;
	/** BLMOVE block seconds per poll — default 5. */
	readonly blockSeconds?: number;
	/** Delayed-delivery sweep interval ms — default 1000. Envelopes
	 * carrying `runAt` park on the `<queue>:delayed` zset until a
	 * sweep moves the due ones onto the list. */
	readonly sweepMs?: number;
	/** Test seam: supply a connected client instead of `url`. */
	readonly client?: RedisLike;
}

/**
 * The Redis jobs transport — a `QueueTransport` (@ktb/queues-port)
 * plus the consumer-side extras only this adapter has: `receive`
 * pulls batches for the jobs-worker loop and `requeuePending` recovers
 * crash-orphaned entries at boot.
 */
export interface RedisJobsTransport extends QueueTransport {
	/** Transport-level list key (e.g. "ktb:jobs") — the QueueTransport
	 * `name` the registry and dispatch derive from. */
	readonly name: string;
	/** LPUSH the serialized envelope — the QueueTransport `send`
	 * widened to `unknown`: the wire payload is whatever the producer
	 * serialized (job envelopes today). */
	readonly send: (body: unknown) => Promise<void>;
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
/** Default list key — exported so composition roots name the queue
 * without duplicating the literal. */
export const DEFAULT_QUEUE = "ktb:jobs";
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
	const pending = `${queue}:pending`;
	const delayed = `${queue}:delayed`;
	const blockSeconds = opts.blockSeconds ?? 5;
	const sweepMs = opts.sweepMs ?? 1000;
	const client: RedisLike =
		opts.client ??
		(await (async () => {
			const c = createClient({ url: opts.url ?? DEFAULT_URL }) as RedisClientType;
			await c.connect();
			return c as unknown as RedisLike;
		})());

	const send = async (body: unknown): Promise<void> => {
		const serialized = JSON.stringify(body);
		// Delayed delivery: a future runAt parks the envelope on the
		// delayed zset (score = epoch ms); the sweeper LPUSHes it when
		// due. Past/absent runAt — or a client without zset support —
		// delivers immediately (early beats stalled). `body` is `unknown`
		// at the QueueTransport seam, so runAt is read defensively.
		const runAt = isRecord(body) ? body["runAt"] : undefined;
		if (
			typeof runAt === "number" &&
			Number.isFinite(runAt) &&
			runAt > Date.now() &&
			client.zAdd !== undefined
		) {
			await client.zAdd(delayed, { score: runAt, value: serialized });
			return;
		}
		await client.lPush(queue, serialized);
	};

	// Atomic due-sweep: ZRANGEBYSCORE + per-member ZREM/LPUSH inside
	// one Lua eval, so a crash mid-sweep can neither double-deliver
	// (ZREM gates the LPUSH) nor silently drop an entry.
	const SWEEP_DUE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local moved = 0
for _, member in ipairs(due) do
  if redis.call('ZREM', KEYS[1], member) == 1 then
    redis.call('LPUSH', KEYS[2], member)
    moved = moved + 1
  end
end
return moved
`;
	const SWEEP_BATCH = 100;
	const sweepDelayed = async (): Promise<void> => {
		if (client.eval === undefined) return;
		try {
			await client.eval(SWEEP_DUE, {
				keys: [delayed, queue],
				arguments: [String(Date.now()), String(SWEEP_BATCH)],
			});
		} catch (error) {
			console.warn("jobs transport: delayed sweep failed", { error: String(error) });
		}
	};
	// unref'd like the dev:node poller — an idle transport never keeps
	// the process alive; close() clears it.
	const sweepTimer = setInterval(() => void sweepDelayed(), sweepMs);
	sweepTimer.unref();

	const receive = async (count = 1): Promise<readonly JobMessageLike[]> => {
		const messages: JobMessageLike[] = [];
		for (let i = 0; i < count; i++) {
			const timeout = messages.length === 0 ? blockSeconds : BATCH_FILL_BLOCK_SECONDS;
			const body = await client.blMove(queue, pending, "RIGHT", "LEFT", timeout);
			if (body === null) break;
			const parsed = safeParse(body);
			const attempts = deliveryAttempts(parsed);
			messages.push({
				body: parsed,
				attempts,
				// ack clears the pending copy — the entry is already off
				// the queue, so a crash before ack leaves it requeueable.
				ack: () => {
					void client.lRem(pending, 1, body).catch(() => {});
				},
				retry: () => {
					// Re-push BEFORE clearing pending: a crash between the
					// two leaves the pending copy for the reaper, never
					// loses the job (at-least-once over exactly-once).
					// RPUSH puts it at the tail — the next pop delivers it,
					// with the delivery count incremented on the envelope.
					const requeue = isRecord(parsed)
						? JSON.stringify({ ...parsed, attempts: attempts + 1 })
						: body;
					void (async () => {
						await client.rPush(queue, requeue);
						await client.lRem(pending, 1, body);
					})().catch((error: unknown) =>
						console.warn("jobs transport: retry requeue failed", { error: String(error) }),
					);
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
		name: queue,
		send,
		receive,
		requeuePending,
		stats: async () => {
			const [pendingCount, inflight, delayedCount] = await Promise.all([
				client.lLen(queue),
				client.lLen(pending),
				client.zCard === undefined ? Promise.resolve(0) : client.zCard(delayed),
			]);
			// Delayed entries count as pending backlog — they are queued
			// work, just not yet deliverable.
			return {
				pending: pendingCount + delayedCount,
				processing: inflight,
				done: 0,
				failed: 0,
			};
		},
		close: async () => {
			clearInterval(sweepTimer);
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Delivery count carried on the envelope's `attempts` field; absent or
 * malformed counts as the first delivery. */
const deliveryAttempts = (body: unknown): number => {
	if (!isRecord(body)) return 1;
	const n = body.attempts;
	return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
};
