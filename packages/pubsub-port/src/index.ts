/**
 * @ktb/pubsub-port — the cloud-agnostic pub/sub contract: topic
 * introspection for the /platform/pubsub console plus the bus surface
 * adapters implement. A topic here is a NAMED channel on a transport
 * the deployment actually binds — the in-process bus, a Redis pub/sub
 * channel set, or a future broker — never a provider-specific type.
 *
 * Unlike queues, pub/sub topics are DYNAMIC: transports enumerate
 * their own channels (Redis `PUBSUB CHANNELS`, the in-process bus's
 * known-topic set), so introspection goes through `PubSubTopicSource`
 * implementations the composition root merges — there is no static
 * descriptor list to drift out of date.
 *
 * Delivery semantics stay at the edge per ADR-0001: this package owns
 * the contract and the zero-dependency in-process reference adapter;
 * network transports (Redis today) live in adapter packages.
 */

/** Transport family a topic source publishes through. */
export const PubSubTransports = ["in-process", "redis", "unknown"] as const;
export type PubSubTransport = (typeof PubSubTransports)[number];

/** Best-effort counters for one topic — absent probes report null. */
export interface PubSubTopicStats {
	readonly subscribers: number;
}

/** One topic as the console sees it — identity + honest counters. */
export interface PubSubTopicInfo {
	/** Globally unique id — sources prefix it (`memory:cron.fires`,
	 * `redis:ktb:events`) so same-named channels on different
	 * transports never collide. */
	readonly id: string;
	/** Raw topic/channel name on the transport. */
	readonly name: string;
	readonly transport: PubSubTransport;
	/** Live subscriber count; null when the transport cannot report
	 * it — the console renders the honest unavailable state. */
	readonly subscribers: number | null;
	/** Recent payloads the transport retains for inspection (the
	 * in-process bus keeps a bounded ring); undefined when the
	 * transport has no history — never fabricated. */
	readonly recent?: readonly PubSubMessageInfo[];
}

/** One retained message on an introspectable topic. */
export interface PubSubMessageInfo {
	readonly at: number;
	readonly payload: unknown;
}

/** A transport-side topic enumerator the composition root merges.
 * `id` namespaces the source for degraded reporting (`memory`,
 * `redis`, …) — it is NOT the topic-id prefix (topics carry their
 * own `transport:`/`source:` namespacing in `PubSubTopicInfo.id`). */
export interface PubSubTopicSource {
	readonly id: string;
	readonly list: () => Promise<readonly PubSubTopicInfo[]>;
}

/** One merged enumeration: surviving topics plus the ids of sources
 * whose probe failed — a bound-but-down transport is reported
 * honestly instead of silently vanishing into an empty list. */
export interface PubSubTopicListing {
	readonly topics: readonly PubSubTopicInfo[];
	readonly degraded: readonly string[];
}

/** Fan-out several sources into one listing — the first source wins
 * on topic `id` collisions; a throwing source lands in `degraded`. */
export const mergePubSubSources = (
	sources: readonly PubSubTopicSource[],
): { readonly list: () => Promise<PubSubTopicListing> } => ({
	list: async () => {
		const seen = new Map<string, PubSubTopicInfo>();
		const degraded: string[] = [];
		for (const source of sources) {
			try {
				for (const topic of await source.list()) {
					if (!seen.has(topic.id)) seen.set(topic.id, topic);
				}
			} catch {
				degraded.push(source.id);
			}
		}
		return { topics: [...seen.values()], degraded };
	},
});

/**
 * The publish/subscribe surface an adapter exposes. `topic` is the
 * RAW transport channel name (not the console-facing `PubSubTopicInfo.id`).
 */
export interface PubSubBus {
	readonly publish: (topic: string, payload: unknown) => Promise<void>;
	readonly subscribe?: (
		topic: string,
		handler: (payload: unknown) => void | Promise<void>,
	) => Promise<() => void>;
}

export interface InProcessPubSub extends PubSubBus {
	/** Topics with at least one publish or subscriber, sorted. */
	readonly topics: () => readonly string[];
	/** Live listener count for a topic (0 when unknown). */
	readonly subscriberCount: (topic: string) => number;
	/** Bounded recent-message ring per topic (newest last, capped). */
	readonly recentMessages: (topic: string) => readonly PubSubMessageInfo[];
	readonly listTopics: () => readonly PubSubTopicInfo[];
}

const RECENT_CAP = 20;

/**
 * Zero-dependency in-process bus — the local/default transport. One
 * instance per isolate; delivery is synchronous fan-out to registered
 * listeners, publish failures in one listener never starve the rest.
 * Retains a small per-topic message ring so the console can show real
 * recent traffic instead of an empty table.
 */
export const makeInProcessPubSub = (
	options: { readonly idPrefix?: string } = {},
): InProcessPubSub => {
	const prefix = options.idPrefix ?? "memory";
	const listeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
	const recent = new Map<string, PubSubMessageInfo[]>();
	const known = new Set<string>();

	const record = (topic: string, payload: unknown) => {
		known.add(topic);
		const ring = recent.get(topic) ?? [];
		ring.push({ at: Date.now(), payload });
		if (ring.length > RECENT_CAP) ring.splice(0, ring.length - RECENT_CAP);
		recent.set(topic, ring);
	};

	return {
		publish: async (topic, payload) => {
			record(topic, payload);
			const set = listeners.get(topic);
			if (set === undefined) return;
			for (const handler of [...set]) {
				try {
					await handler(payload);
				} catch (error) {
					console.error("in-process pubsub handler failed", { topic, error: String(error) });
				}
			}
		},
		subscribe: async (topic, handler) => {
			known.add(topic);
			const set = listeners.get(topic) ?? new Set();
			set.add(handler);
			listeners.set(topic, set);
			return () => {
				set.delete(handler);
				if (set.size === 0) {
					listeners.delete(topic);
					// A subscribe-only topic with no retained history has
					// nothing left to report — drop it from the listing.
					if (!recent.has(topic)) known.delete(topic);
				}
			};
		},
		topics: () => [...known].sort(),
		subscriberCount: (topic) => listeners.get(topic)?.size ?? 0,
		// Defensive copies — consumers must not mutate retained history.
		recentMessages: (topic) => [...(recent.get(topic) ?? [])],
		listTopics: () =>
			[...known].sort().map((name) => ({
				id: `${prefix}:${name}`,
				name,
				transport: "in-process" as const,
				subscribers: listeners.get(name)?.size ?? 0,
				recent: [...(recent.get(name) ?? [])],
			})),
	};
};
