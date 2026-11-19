/**
 * @ktb/pubsub-transport-redis — the Redis pub/sub transport: the
 * cross-process stand-in for the in-process bus. `PUBLISH` fans a
 * JSON payload out to every subscriber of the channel (including
 * other processes — apps/jobs-worker, a second dev instance); the
 * console introspects channels via `PUBSUB CHANNELS`/`NUMSUB`.
 *
 * Adapter package — Node Redis client at the edge; ports and plugins
 * never import it (wired by apps/web dev composition).
 */

import { createClient, type RedisClientType } from "redis";

import type { PubSubBus, PubSubTopicInfo } from "@ktb/pubsub-port";

/** Minimal client surface the transport needs — injectable for tests. */
export interface RedisPubSubLike {
	publish(channel: string, message: string): Promise<number>;
	sSubscribe?(
		channel: string,
		listener: (message: string, channel: string) => void,
	): Promise<unknown>;
	sUnsubscribe?(channel: string): Promise<unknown>;
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
	 * (null subscribers when the probe fails). */
	readonly listTopics: () => Promise<readonly PubSubTopicInfo[]>;
	readonly close: () => Promise<void>;
}

const DEFAULT_URL = "redis://127.0.0.1:6379";
const DEFAULT_PREFIX = "redis";

const parseNumSub = (raw: unknown): number | null => {
	// node-redis returns a flat array [channel, count, channel, count, ...]
	// (or a Map on some versions); take the first count found.
	if (Array.isArray(raw)) {
		for (let i = 1; i < raw.length; i += 2) {
			const n = Number(raw[i]);
			if (Number.isFinite(n)) return n;
		}
		return null;
	}
	if (raw instanceof Map) {
		for (const v of raw.values()) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return null;
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
		subscribe: client.sSubscribe
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
					await client.sSubscribe!(topic, listener);
					return () => {
						void client.sUnsubscribe?.(topic).catch(() => {});
					};
				}
			: undefined,
		listTopics: async () => {
			if (client.pubSubChannels === undefined) return [];
			const channels = await client.pubSubChannels().catch(() => [] as string[]);
			return Promise.all(
				channels.map(async (name) => ({
					id: `${prefix}:${name}`,
					name,
					transport: "redis" as const,
					subscribers:
						client.pubSubNumSub === undefined
							? null
							: await client
									.pubSubNumSub(name)
									.then(parseNumSub)
									.catch(() => null),
				})),
			);
		},
		close: async () => {
			await client.quit();
		},
	};
};
