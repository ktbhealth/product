/**
 * @ktb/queues-port — the cloud-agnostic queue contract: the
 * `QueueTransport` port every queue mechanism converges on, plus the
 * introspection registry behind the /platform/queue console.
 *
 * A transport here is a NAMED endpoint the deployment actually binds —
 * a Cloudflare Queue binding, the Redis list consumed by
 * apps/jobs-worker, the dev:node SQLite stand-in, or the in-memory
 * reference adapter — never a provider-specific type. `send` produces;
 * `receive` pulls batches (absent on push-delivered transports like
 * Cloudflare Queues, whose messages arrive through the worker entry's
 * `queue` handler); `stats` is the optional depth probe; `close`
 * releases broker resources when the transport holds any.
 *
 * Transports differ in what they can report: the dev:node SQLite queue
 * and the Redis list expose depth probes; prod Cloudflare Queues have
 * no query API, so their `depth` resolves null and the console renders
 * the honest "externally managed" state instead of a fabricated zero.
 * `job_runs` (@ktb/jobs-port) stays the transport-agnostic run
 * projection — per-kind lifecycle counts come from there, not from
 * this registry.
 *
 * Delivery semantics stay at the edge per ADR-0001: this package owns
 * the contract, the zero-dependency binding/memory adapters and the
 * registry; network transports (Redis today) live in adapter packages.
 */

/** Transport family a queue descriptor was composed from. */
export const QueueTransportKinds = ["cloudflare-queue", "redis", "sqlite", "unknown"] as const;
export type QueueTransportKind = (typeof QueueTransportKinds)[number];

/** Who drains the queue — drives the console's consumer column. */
export const QueueConsumers = ["in-app", "jobs-worker", "external", "none"] as const;
export type QueueConsumer = (typeof QueueConsumers)[number];

/**
 * Row-count snapshot of a queue's pending work, grouped by delivery
 * status. Structurally identical to the `QueueDepth` mirror declared in
 * @ktb/server-fns — declared here so adapters need no server-fns dep.
 */
export interface QueueDepthStats {
	readonly pending: number;
	readonly processing: number;
	readonly done: number;
	readonly failed: number;
}

/**
 * One delivered queue message — the consumer-edge slice every
 * transport converges on (workerd `Message`, dev:node
 * `LocalQueueMessage` and @ktb/jobs-port's `JobMessageLike` all
 * satisfy it). `attempts` is the transport-reported delivery count
 * when the broker tracks one.
 */
export interface QueueMessage {
	readonly body: unknown;
	readonly attempts?: number;
	ack(): void;
	retry(): void;
}

/**
 * The queue transport port: one named endpoint with a send surface,
 * an optional pull surface and an optional depth probe.
 *
 * `receive` is absent on push-delivered transports — Cloudflare Queues
 * hand batches to the worker entry's `queue` handler rather than
 * offering a pull API, so a binding-backed transport exposes send (+
 * stats when the binding happens to carry a probe) and nothing else.
 * `stats` resolves null when the probe cannot answer; transports with
 * no query surface omit it entirely (the registry then reports null
 * depth — the honest "externally managed" state).
 */
export interface QueueTransport {
	/** Enqueue one message body (JSON-serializable at the edge). */
	readonly send: (body: unknown) => Promise<unknown>;
	/** Pull up to `count` messages as an ack/retry batch. Absent on
	 * push-delivered transports. */
	readonly receive?: (count?: number) => Promise<readonly QueueMessage[]>;
	/** Depth probe — resolve null on failure; absent means the
	 * transport has no query surface at all. */
	readonly stats?: () => Promise<QueueDepthStats | null>;
	/** Release broker resources (connections, pollers); absent when the
	 * transport holds none. */
	readonly close?: () => Promise<void> | void;
	/** Transport-level queue name when the broker assigns one
	 * (e.g. "ktb-transcription", "ktb:jobs") — introspection and
	 * dispatch keying derive from this, never from string literals. */
	readonly name?: string;
}

/** One queue as the console sees it — identity + best-effort depth. */
export interface QueueInfo {
	/** Logical id the deployment assigns (e.g. "audio", "theme-assets", "jobs"). */
	readonly id: string;
	/** Transport-level name (e.g. "ktb-transcription", "ktb:jobs"). */
	readonly name: string;
	readonly transport: QueueTransportKind;
	readonly consumer: QueueConsumer;
	/** Broker-side depth; null when the transport cannot report it. */
	readonly depth: QueueDepthStats | null;
}

/** Static facts about a bound queue plus its transport and an optional
 * depth probe override. */
export interface QueueDescriptor {
	readonly id: string;
	readonly name: string;
	readonly transport: QueueTransportKind;
	readonly consumer?: QueueConsumer;
	/** Bound transport instance — its `stats()` is the depth probe
	 * unless `stats` overrides it. */
	readonly queue?: QueueTransport;
	/** Depth probe — resolve null on failure; absent means the
	 * transport has no query surface at all. */
	readonly stats?: () => Promise<QueueDepthStats | null>;
}

export interface QueueRegistry {
	readonly list: () => Promise<readonly QueueInfo[]>;
}

/**
 * Build a descriptor from a bound transport: the transport's own
 * `name` supplies the transport-level name unless `meta.name`
 * overrides it, and `kind` defaults to "unknown" — pass the family
 * the composition root detected ("cloudflare-queue", "redis",
 * "sqlite").
 */
export const queueDescriptorFor = (
	queue: QueueTransport,
	meta: {
		readonly id: string;
		readonly name?: string;
		readonly kind?: QueueTransportKind;
		readonly consumer?: QueueConsumer;
	},
): QueueDescriptor => ({
	id: meta.id,
	name: meta.name ?? queue.name ?? meta.id,
	transport: meta.kind ?? "unknown",
	...(meta.consumer !== undefined ? { consumer: meta.consumer } : {}),
	queue,
});

/**
 * Build the registry from composition-time descriptors. `list()`
 * resolves every depth probe concurrently — an explicit `stats`
 * override wins, otherwise the bound transport's own `stats()` is
 * used; a throwing or absent probe collapses to null (unavailable) —
 * introspection must never take the console down because one
 * transport is unreachable.
 */
export const makeQueueRegistry = (descriptors: readonly QueueDescriptor[]): QueueRegistry => ({
	list: async () =>
		Promise.all(
			descriptors.map(async (d) => {
				const boundStats = d.queue?.stats;
				const probe =
					d.stats ?? (boundStats === undefined ? undefined : () => boundStats.call(d.queue));
				return {
					id: d.id,
					name: d.name,
					transport: d.transport,
					consumer: d.consumer ?? "external",
					depth: probe === undefined ? null : await probe().catch(() => null),
				};
			}),
		),
});

// ---------------------------------------------------------------------------
// Adapters.
// ---------------------------------------------------------------------------

/**
 * The minimal producer binding a queue endpoint exposes — the shape
 * Cloudflare Queue bindings (`send` only) and dev doubles satisfy.
 * `stats`/`name` are picked up structurally when present (the dev:node
 * SQLite stand-in carries a depth probe; a bare workerd Queue binding
 * does not).
 */
export interface QueueBindingLike {
	send(body: unknown, options?: unknown): Promise<unknown>;
	stats?: () => Promise<QueueDepthStats | null>;
	name?: string;
}

/**
 * Adapt a bound producer into a `QueueTransport` — the Cloudflare
 * Queue binding adapter. Push-delivered: no `receive` (batches arrive
 * via the worker entry's `queue` handler); `stats` passes through only
 * when the binding carries a probe.
 */
export const asQueueTransport = (
	binding: QueueBindingLike,
	meta: { readonly name?: string } = {},
): QueueTransport => {
	const stats = binding.stats;
	const name = meta.name ?? binding.name;
	return {
		send: (body) => binding.send(body),
		...(stats === undefined ? {} : { stats: () => stats.call(binding) }),
		...(name === undefined ? {} : { name }),
	};
};

export interface MemoryQueueTransport extends QueueTransport {
	readonly close: () => void;
}

/**
 * Zero-dependency in-memory transport — the reference adapter and the
 * contract-suite subject. FIFO queue with ack/retry settlement:
 * `receive` marks entries in-flight (attempts count deliveries), `ack`
 * drops the entry, `retry` requeues it for the next receive. `done`/
 * `failed` have no broker-side meaning — settled entries are removed,
 * so stats reports live depth only.
 */
export const makeMemoryQueueTransport = (
	options: { readonly name?: string } = {},
): MemoryQueueTransport => {
	interface Entry {
		body: unknown;
		state: "queued" | "inflight";
		attempts: number;
	}
	const entries: Entry[] = [];
	const count = (state: Entry["state"]) => entries.filter((e) => e.state === state).length;
	return {
		...(options.name === undefined ? {} : { name: options.name }),
		send: async (body) => {
			entries.push({ body, state: "queued", attempts: 0 });
			return {};
		},
		receive: async (count = 1) => {
			const messages: QueueMessage[] = [];
			for (const entry of entries) {
				if (messages.length >= count) break;
				if (entry.state !== "queued") continue;
				entry.state = "inflight";
				entry.attempts += 1;
				messages.push({
					body: entry.body,
					attempts: entry.attempts,
					ack: () => {
						const index = entries.indexOf(entry);
						if (index >= 0) entries.splice(index, 1);
					},
					retry: () => {
						entry.state = "queued";
					},
				});
			}
			return messages;
		},
		stats: async () => ({
			pending: count("queued"),
			processing: count("inflight"),
			done: 0,
			failed: 0,
		}),
		close: () => {
			entries.length = 0;
		},
	};
};
