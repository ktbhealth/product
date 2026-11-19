/**
 * @ktb/queues-port — the cloud-agnostic queue registry: the
 * introspection contract behind the /platform/queue console. A queue
 * here is a NAMED transport endpoint the deployment actually binds —
 * a Cloudflare Queue binding, the local Redis list consumed by
 * apps/jobs-worker, or the dev:node SQLite stand-in — never a
 * provider-specific type.
 *
 * Transports differ in what they can report: the dev:node SQLite queue
 * and the Redis list expose depth probes; prod Cloudflare Queues have
 * no query API, so their `depth` resolves null and the console renders
 * the honest "externally managed" state instead of a fabricated zero.
 * `job_runs` (@ktb/jobs-port) stays the transport-agnostic run
 * projection — per-kind lifecycle counts come from there, not from
 * this registry.
 */

/** Transport family a queue descriptor was composed from. */
export const QueueTransports = ["cloudflare-queue", "redis", "sqlite", "unknown"] as const;
export type QueueTransport = (typeof QueueTransports)[number];

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

/** One queue as the console sees it — identity + best-effort depth. */
export interface QueueInfo {
	/** Logical id the deployment assigns (e.g. "audio", "theme-assets", "jobs"). */
	readonly id: string;
	/** Transport-level name (e.g. "ktb-transcription", "ktb:jobs"). */
	readonly name: string;
	readonly transport: QueueTransport;
	readonly consumer: QueueConsumer;
	/** Broker-side depth; null when the transport cannot report it. */
	readonly depth: QueueDepthStats | null;
}

/** Static facts about a bound queue plus an optional depth probe. */
export interface QueueDescriptor {
	readonly id: string;
	readonly name: string;
	readonly transport: QueueTransport;
	readonly consumer?: QueueConsumer;
	/** Depth probe — resolve null on failure; absent means the
	 * transport has no query surface at all. */
	readonly stats?: () => Promise<QueueDepthStats | null>;
}

export interface QueueRegistry {
	readonly list: () => Promise<readonly QueueInfo[]>;
}

/**
 * Build the registry from composition-time descriptors. `list()`
 * resolves every depth probe concurrently; a throwing or absent probe
 * collapses to null (unavailable) — introspection must never take the
 * console down because one transport is unreachable.
 */
export const makeQueueRegistry = (descriptors: readonly QueueDescriptor[]): QueueRegistry => ({
	list: async () =>
		Promise.all(
			descriptors.map(async (d) => ({
				id: d.id,
				name: d.name,
				transport: d.transport,
				consumer: d.consumer ?? "external",
				depth: d.stats === undefined ? null : await d.stats().catch(() => null),
			})),
		),
});
