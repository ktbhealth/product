import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { and, desc, eq, isNull, like, type SQL } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { jobRuns } from "@ktb/db/schema";

/**
 * @ktb/jobs-port — the generic job backbone (PL-007): an enqueue port,
 * the wire message envelope, a kind→handler consumer dispatch and the
 * `job_runs` status projection. Transport (Cloudflare Queue today) and
 * payload schemas stay at the edge per ADR-0001; this package owns the
 * contract, the projection repo helpers and the dispatch loop.
 *
 * Named `jobs-port` because `@ktb/jobs` is already the /platform jobs
 * console plugin — this is the infra port beneath it.
 */

export const JobStatusSchema = Schema.Literals(["queued", "processing", "done", "failed"]);
export type JobStatus = typeof JobStatusSchema.Type;

/**
 * Wire envelope every queued job message must satisfy at the consumer
 * edge — the same trust boundary the old AudioJobMessageSchema sat on.
 * `payload` stays `unknown` here; each kind's registration validates it
 * (JobRegistration.decodePayload).
 */
export const JobEnvelopeSchema = Schema.Struct({
	id: Schema.String,
	kind: Schema.NonEmptyString,
	payload: Schema.optionalKey(Schema.Unknown),
	// Optional + nullable: pre-tenancy messages carry no tenant_id and
	// decode as personal scope (same convention as AudioJobMessage).
	tenantId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type JobEnvelope = typeof JobEnvelopeSchema.Type;

/** Row shape of the `job_runs` status projection. */
export const JobRecordSchema = Schema.Struct({
	id: Schema.String,
	kind: Schema.String,
	status: JobStatusSchema,
	payloadRef: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	tenantId: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
});
export type JobRecord = typeof JobRecordSchema.Type;

/** Options accepted by the enqueue port. */
export interface EnqueueJobOptions {
	/** Owning tenant (`groups.id`) or null/absent for personal scope. */
	readonly tenantId?: number | null;
	/** Optional pointer to where the payload lives — never PHI/blob inline. */
	readonly payloadRef?: string | null;
}

/**
 * Jobs port: enqueue a `{kind, payload}` job onto the configured
 * transport and record it in the `job_runs` projection. Implementations
 * are composed at the edge (apps/web binds the queue + Db).
 */
export interface JobsEnqueuer {
	enqueue(kind: string, payload: unknown, options?: EnqueueJobOptions): Promise<JobEnvelope>;
}

/** Effect service face of the port — the value is the enqueuer itself. */
export class Jobs extends Context.Service<Jobs, JobsEnqueuer>()("@ktb/jobs-port/Jobs") {}

/** Full field set accepted by the job_runs repo helpers. */
export interface JobRunWrite {
	readonly id: string;
	readonly kind: string;
	readonly status: JobStatus;
	readonly payloadRef?: string | null;
	readonly error?: string | null;
	readonly tenantId?: number | null;
}

const runValues = (run: JobRunWrite, now: number) => ({
	id: run.id,
	kind: run.kind,
	status: run.status,
	payloadRef: run.payloadRef ?? null,
	error: run.error ?? null,
	tenantId: run.tenantId ?? null,
	createdAt: now,
	updatedAt: now,
});

/** Insert a fresh projection row (enqueue path — ids are unique). */
export const insertJobRun = async (
	db: DbClient,
	run: JobRunWrite,
	now = Date.now(),
): Promise<void> => {
	await db.insert(jobRuns).values(runValues(run, now));
};

/**
 * Insert-or-update a projection row (consumer path). On conflict only
 * the mutable fields move — status, error, updatedAt — so identity
 * fields written at enqueue (payloadRef, tenantId, kind) are preserved.
 */
export const upsertJobRun = async (
	db: DbClient,
	run: JobRunWrite,
	now = Date.now(),
): Promise<void> => {
	await db
		.insert(jobRuns)
		.values(runValues(run, now))
		.onConflictDoUpdate({
			target: jobRuns.id,
			set: { status: run.status, error: run.error ?? null, updatedAt: now },
		});
};

const toRecord = (row: typeof jobRuns.$inferSelect): JobRecord => ({
	id: row.id,
	kind: row.kind,
	status: row.status as JobStatus,
	payloadRef: row.payloadRef,
	error: row.error,
	tenantId: row.tenantId,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

/** Fetch one projection row by envelope id; null when absent. */
export const getJobRun = async (db: DbClient, id: string): Promise<JobRecord | null> => {
	const rows = await db.select().from(jobRuns).where(eq(jobRuns.id, id)).limit(1);
	const row = rows[0];
	return row === undefined ? null : toRecord(row);
};

export interface JobRunFilter {
	readonly kind?: string;
	/** Prefix match on kind — e.g. "cron." selects every scheduled-job
	 * projection row regardless of the job id suffix. LIKE semantics:
	 * `%`/`_` inside the prefix act as wildcards, so callers must pass
	 * constant, wildcard-free prefixes (never user input). */
	readonly kindPrefix?: string;
	readonly status?: JobStatus;
	/** undefined = any scope; null = personal scope only; number = that tenant. */
	readonly tenantId?: number | null;
	readonly limit?: number;
}

/** Console-feed read: newest first, optionally filtered. */
export const listJobRuns = async (
	db: DbClient,
	filter: JobRunFilter = {},
): Promise<JobRecord[]> => {
	const conditions: SQL[] = [];
	if (filter.kind !== undefined) conditions.push(eq(jobRuns.kind, filter.kind));
	if (filter.kindPrefix !== undefined) conditions.push(like(jobRuns.kind, `${filter.kindPrefix}%`));
	if (filter.status !== undefined) conditions.push(eq(jobRuns.status, filter.status));
	if (filter.tenantId !== undefined) {
		conditions.push(
			filter.tenantId === null ? isNull(jobRuns.tenantId) : eq(jobRuns.tenantId, filter.tenantId),
		);
	}
	const rows = await db
		.select()
		.from(jobRuns)
		.where(
			// Stryker disable next-line ConditionalExpression: and() with zero conditions returns undefined — identical to the empty-conditions branch
			conditions.length === 0 ? undefined : and(...conditions),
		)
		.orderBy(desc(jobRuns.createdAt), desc(jobRuns.id))
		.limit(filter.limit ?? 100);
	return rows.map(toRecord);
};

export interface JobsDeps {
	/** Transport send — the edge adapts the queue binding to this. */
	readonly send: (envelope: JobEnvelope) => Promise<unknown>;
	/** When bound, every enqueue also writes the job_runs projection. */
	readonly db?: DbClient;
	readonly newId?: () => string;
	readonly now?: () => number;
}

/**
 * Build the enqueuer: writes the `job_runs` row first (status "queued"),
 * then sends the envelope. A projection failure aborts before anything
 * is in flight; a send failure marks the row failed and rethrows so the
 * caller reports an honest enqueue failure.
 */
export const makeJobs = (deps: JobsDeps): JobsEnqueuer => ({
	enqueue: async (kind, payload, options = {}) => {
		if (kind.length === 0) throw new Error("job kind must be non-empty");
		const now = deps.now?.() ?? Date.now();
		const envelope: JobEnvelope = {
			id: deps.newId?.() ?? crypto.randomUUID(),
			kind,
			payload,
			...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
		};
		if (deps.db !== undefined) {
			await insertJobRun(
				deps.db,
				{
					id: envelope.id,
					kind,
					status: "queued",
					payloadRef: options.payloadRef ?? null,
					tenantId: options.tenantId ?? null,
				},
				now,
			);
		}
		try {
			await deps.send(envelope);
		} catch (error) {
			// Stryker disable next-line ConditionalExpression: with no db bound the upsert rejects on undefined.insert and is swallowed by .catch(() => {}) below — same observable behavior
			if (deps.db !== undefined) {
				// Best-effort: the send already failed — a projection write
				// failure must not mask the original error.
				await upsertJobRun(
					deps.db,
					{
						id: envelope.id,
						kind,
						status: "failed",
						error: String(error),
						tenantId: options.tenantId ?? null,
					},
					now,
				).catch(() => {});
			}
			throw error;
		}
		return envelope;
	},
});

/** Layer face for Effect compositions: `Layer.provide(JobsLive(deps))`. */
export const JobsLive = (deps: JobsDeps): Layer.Layer<Jobs> => Layer.succeed(Jobs, makeJobs(deps));

// ---------------------------------------------------------------------------
// Consumer side: kind-dispatched batch handler.
// ---------------------------------------------------------------------------

/** The slice of a queue message the consumer needs (workerd Message /
 * dev:node LocalQueueMessage both satisfy this). `attempts` is the
 * transport-reported delivery count when the broker tracks one
 * (Cloudflare Queues does; the Redis list transport does not). */
export interface JobMessageLike {
	readonly body: unknown;
	readonly attempts?: number;
	ack(): void;
	retry(): void;
}

/** Result of normalizing a raw message body into a dispatchable job. */
export interface NormalizedJob {
	readonly kind: string;
	readonly payload: unknown;
	readonly id?: string;
	readonly tenantId?: number | null;
}

export type JobNormalizer = (body: unknown) => NormalizedJob | null;

/** Default normalizer: decode the wire envelope; anything else is poison. */
export const decodeJobEnvelope = (body: unknown): NormalizedJob | null => {
	try {
		const envelope = Schema.decodeUnknownSync(JobEnvelopeSchema)(body);
		return {
			kind: envelope.kind,
			payload: envelope.payload,
			id: envelope.id,
			tenantId: envelope.tenantId ?? null,
		};
	} catch {
		return null;
	}
};

/**
 * One kind's consumer registration. `decodePayload` is the per-kind
 * schema check at the consumer edge — a throw marks the run failed and
 * acks the message (poison payloads are never retried). `handle` runs
 * the job; a throw marks the run failed and retries the message.
 *
 * Hardening knobs:
 * - `concurrency`: max in-flight executions of this kind within one
 *   consumer batch (default 1 — kinds still run serially against each
 *   other, but different kinds may overlap).
 * - `maxAttempts`: delivery count at which the consumer acks instead
 *   of retrying, marking the run failed with an "attempts exhausted"
 *   error (default `JobConsumerDeps.maxAttempts`, then 5). Only binds
 *   on transports that report `message.attempts`.
 * - `idempotent`: when true and a db projection is bound, a redelivery
 *   whose job_run is already `done` is acked without re-running —
 *   covers ack-loss redelivery on at-least-once transports.
 */
export interface JobRegistration {
	readonly decodePayload?: (payload: unknown) => unknown;
	readonly handle: (payload: unknown, envelope: JobEnvelope) => Promise<void>;
	readonly concurrency?: number;
	readonly maxAttempts?: number;
	readonly idempotent?: boolean;
}

export type JobHandlers = Readonly<Record<string, JobRegistration>>;

/**
 * Kind → handler registry for the shared jobs queue consumer (PL-007).
 * The composition root (apps/web) registers non-built-in kinds here at
 * startup — domain plugins contribute their registrations through the
 * edge modules that own the platform bindings, never from request
 * paths.
 */
export const jobHandlers: Record<string, JobRegistration> = {};

/** Register (or replace) a job kind handler. Called once at app
 * composition by the owning edge module — never from request paths. */
export const registerJobHandler = (kind: string, registration: JobRegistration): void => {
	jobHandlers[kind] = registration;
};

export interface JobConsumerDeps {
	readonly handlers: JobHandlers;
	/** When bound, delivery lifecycle writes the job_runs projection
	 * (best-effort — a projection failure never fails the job). */
	readonly db?: DbClient;
	/** Wire normalizer — defaults to the envelope decoder. Pre-envelope
	 * producers can supply a normalizer that maps legacy bodies onto a
	 * kind. */
	readonly normalize?: JobNormalizer;
	readonly newId?: () => string;
	readonly now?: () => number;
	/** Default attempt ceiling for kinds without their own
	 * `maxAttempts` (default 5). Only binds when the transport reports
	 * `message.attempts`; queue-level retry limits (e.g. the Alchemy
	 * `maxRetries: 3` consumer settings) usually fire first. */
	readonly maxAttempts?: number;
}

/**
 * Build the queue batch consumer: decode → dispatch by `kind` → ack.
 * Malformed bodies are acked (poison); unknown kinds and invalid
 * payloads are acked after a failed projection mark; handler throws
 * mark the run failed and retry the message until the kind's
 * `maxAttempts` ceiling, then ack as exhausted.
 *
 * Messages dispatch concurrently bounded by each kind's
 * `JobRegistration.concurrency` (default 1): same-kind messages keep
 * FIFO order, different kinds overlap. `idempotent` kinds skip
 * redeliveries whose projection already reads `done`.
 */
export const makeJobConsumer = (deps: JobConsumerDeps) => {
	const normalize = deps.normalize ?? decodeJobEnvelope;
	const newId = deps.newId ?? (() => crypto.randomUUID());
	// Stryker disable next-line ArrowFunction: now() -> undefined makes upsertJobRun fall back to its `now = Date.now()` default parameter — identical timestamps
	const now = deps.now ?? (() => Date.now());
	const mark = async (run: JobRunWrite): Promise<void> => {
		if (deps.db === undefined) return;
		try {
			await upsertJobRun(deps.db, run, now());
		} catch (error) {
			// Projection is best-effort: the job itself must not fail
			// (or retry) because job_runs is unavailable.
			console.warn("job_runs projection write failed", { id: run.id, error: String(error) });
		}
	};
	// Per-kind in-flight semaphores: messages of the same kind run at
	// most `concurrency` at a time (FIFO waiter order preserved);
	// different kinds overlap. The batch is awaited as a whole, so a
	// saturated kind only delays its own tail, never the batch.
	const slots = new Map<string, { active: number; queue: Array<() => void> }>();
	const acquire = (kind: string, limit: number): Promise<void> =>
		new Promise((resolve) => {
			const slot = slots.get(kind) ?? { active: 0, queue: [] };
			slots.set(kind, slot);
			const grant = () => {
				slot.active += 1;
				resolve();
			};
			// Stryker disable next-line ConditionalExpression: slot.active < limit vs always-grant differ only under concurrency>1 pressure — covered by the parallel-dispatch test
			if (slot.active < limit) grant();
			else slot.queue.push(grant);
		});
	const release = (kind: string): void => {
		const slot = slots.get(kind);
		if (slot === undefined) return;
		slot.active -= 1;
		const next = slot.queue.shift();
		// The queued grant re-increments `active` itself.
		if (next !== undefined) next();
	};
	const defaultMaxAttempts = deps.maxAttempts ?? 5;
	return async (messages: readonly JobMessageLike[]): Promise<void> => {
		await Promise.all(
			messages.map(async (message) => {
				const normalized = normalize(message.body);
				if (normalized === null) {
					message.ack();
					return;
				}
				const id = normalized.id ?? newId();
				const kind = normalized.kind;
				const tenantId = normalized.tenantId ?? null;
				const registration = deps.handlers[kind];
				const envelope: JobEnvelope = { id, kind, payload: normalized.payload, tenantId };
				if (registration === undefined) {
					await mark({ id, kind, status: "failed", error: `unknown job kind: ${kind}`, tenantId });
					message.ack();
					return;
				}
				// Idempotent kinds: an already-done run means this is an
				// ack-loss redelivery — ack without re-running. A
				// projection read failure degrades to normal dispatch.
				if (registration.idempotent === true && deps.db !== undefined) {
					const existing = await getJobRun(deps.db, id).catch(() => null);
					if (existing?.status === "done") {
						message.ack();
						return;
					}
				}
				const limit = Math.max(1, registration.concurrency ?? 1);
				await acquire(kind, limit);
				try {
					await mark({ id, kind, status: "processing", tenantId });
					let payload: unknown;
					try {
						payload =
							registration.decodePayload === undefined
								? normalized.payload
								: registration.decodePayload(normalized.payload);
					} catch {
						await mark({ id, kind, status: "failed", error: "invalid job payload", tenantId });
						message.ack();
						return;
					}
					try {
						await registration.handle(payload, envelope);
					} catch (error) {
						const detail = String(error);
						const attempts = message.attempts ?? 1;
						const maxAttempts = registration.maxAttempts ?? defaultMaxAttempts;
						if (attempts >= maxAttempts) {
							await mark({
								id,
								kind,
								status: "failed",
								error: `attempts exhausted (${attempts}/${maxAttempts}): ${detail}`,
								tenantId,
							});
							message.ack();
							return;
						}
						await mark({ id, kind, status: "failed", error: detail, tenantId });
						message.retry();
						return;
					}
					await mark({ id, kind, status: "done", error: null, tenantId });
					message.ack();
				} finally {
					release(kind);
				}
			}),
		);
	};
};
