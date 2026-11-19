/**
 * @ktb/pubsub-transport-redis — the Redis pub/sub transport: the
 * cross-process stand-in for the in-process bus. `PUBLISH` fans a
 * JSON payload out to every subscriber of the channel (including
 * other processes — apps/jobs-worker, a second dev instance);
 * regular `SUBSCRIBE`/`UNSUBSCRIBE` (NOT the sharded variants —
 * `PUBLISH` and `PUBSUB CHANNELS`/`NUMSUB` live in the regular
 * channel space) and the console introspects channels via
 * `PUBSUB CHANNELS`/`NUMSUB`.
 *
 * Adapter package — Node Redis client at the edge; ports and plugins
 * never import it (wired by apps/web dev composition).
 */

import { createClient, type RedisClientType } from "redis";

import type { PubSubBus, PubSubTopicInfo } from "@ktb/pubsub-port";

/** Minimal client surface the transport needs — injectable for tests. */
export interface RedisPubSubLike {
	publish(channel: string, message: string): Promise<number>;
	subscribe?(
		channel: string,
		listener: (message: string, channel: string) => void,
	): Promise<unknown>;
	unsubscribe?(
		channel: string,
		listener: (message: string, channel: string) => void,
	): Promise<unknown>;
	pubSubChannels?(): Promise<string[]>;
	pubSubNumSub?(...channels: string[]): Promise<unknown>;
	quit(): Promise<unknown>;
}

export interface RedisPubSubTransportOptions {
	/** Redis URL — default `redis://127.0.0.1:6379`. */
	readonly url?: string;
	/** Console-facing id prefix — default `redis`. */
	readonly idPrefix?: string;
	/** Test seam: supply a connected client instead of `url`. */
	readonly client?: RedisPubSubLike;
}

export interface RedisPubSubTransport extends PubSubBus {
	/** Channel enumeration for the /platform/pubsub console — each
	 * channel becomes a `redis:<channel>` topic with its NUMSUB count
	 * (null subscribers when the probe fails). A `PUBSUB CHANNELS`
	 * failure REJECTS so the merge layer can report the source as
	 * degraded rather than silently listing zero topics. */
	readonly listTopics: () => Promise<readonly PubSubTopicInfo[]>;
	readonly close: () => Promise<void>;
}

const DEFAULT_URL = "redis://127.0.0.1:6379";
const DEFAULT_PREFIX = "redis";

/** NUMSUB replies vary by client/version: flat `[ch,count,…]` arrays,
 * Maps, or plain objects keyed by channel. Returns channel→count. */
const parseNumSub = (raw: unknown, channels: readonly string[]): Map<string, number | null> => {
	const out = new Map<string, number | null>(channels.map((c) => [c, null]));
	const put = (channel: unknown, count: unknown) => {
		if (typeof channel !== "string" || !out.has(channel)) return;
		const n = Number(count);
		if (Number.isFinite(n)) out.set(channel, n);
	};
	if (Array.isArray(raw)) {
		for (let i = 0; i + 1 < raw.length; i += 2) put(raw[i], raw[i + 1]);
	} else if (raw instanceof Map) {
		for (const [channel, count] of raw) put(channel, count);
	} else if (raw !== null && typeof raw === "object") {
		for (const [channel, count] of Object.entries(raw)) put(channel, count);
	}
	return out;
};

export const createRedisPubSubTransport = async (
	opts: RedisPubSubTransportOptions = {},
): Promise<RedisPubSubTransport> => {
	const prefix = opts.idPrefix ?? DEFAULT_PREFIX;
	const client: RedisPubSubLike =
		opts.client ??
		(await (async () => {
			const c = createClient({ url: opts.url ?? DEFAULT_URL }) as RedisClientType;
			await c.connect();
			return c as unknown as RedisPubSubLike;
		})());

	return {
		publish: async (topic, payload) => {
			await client.publish(topic, JSON.stringify(payload ?? null));
		},
		subscribe: client.subscribe
			? async (topic, handler) => {
					const listener = (message: string) => {
						try {
							void Promise.resolve(handler(JSON.parse(message))).catch((e: unknown) => {
								console.error("redis pubsub handler failed", { topic, error: String(e) });
							});
						} catch {
							void Promise.resolve(handler(message)).catch(() => {});
						}
					};
					await client.subscribe!(topic, listener);
					// Per-listener unsubscribe — two subscribers on the same
					// channel must not tear each other down.
					return () => {
						void client.unsubscribe?.(topic, listener).catch(() => {});
					};
				}
			: undefined,
		listTopics: async () => {
			if (client.pubSubChannels === undefined) return [];
			// Failure propagates — mergePubSubSources marks this source
			// degraded instead of reporting a fake empty channel set.
			const channels = await client.pubSubChannels();
			const counts =
				client.pubSubNumSub === undefined || channels.length === 0
					? new Map<string, number | null>()
					: await client
							.pubSubNumSub(...channels)
							.then((raw) => parseNumSub(raw, channels))
							.catch(() => new Map<string, number | null>());
			return channels.map((name) => ({
				id: `${prefix}:${name}`,
				name,
				transport: "redis" as const,
				subscribers: client.pubSubNumSub === undefined ? null : (counts.get(name) ?? null),
			}));
		},
		close: async () => {
			await client.quit();
		},
	};
};
