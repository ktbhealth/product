import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";

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
	if (filter.status !== undefined) conditions.push(eq(jobRuns.status, filter.status));
	if (filter.tenantId !== undefined) {
		conditions.push(
			filter.tenantId === null ? isNull(jobRuns.tenantId) : eq(jobRuns.tenantId, filter.tenantId),
		);
	}
	const rows = await db
		.select()
		.from(jobRuns)
		.where(conditions.length === 0 ? undefined : and(...conditions))
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
 * dev:node LocalQueueMessage both satisfy this). */
export interface JobMessageLike {
	readonly body: unknown;
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
 */
export interface JobRegistration {
	readonly decodePayload?: (payload: unknown) => unknown;
	readonly handle: (payload: unknown, envelope: JobEnvelope) => Promise<void>;
}

export type JobHandlers = Readonly<Record<string, JobRegistration>>;

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
}

/**
 * Build the queue batch consumer: decode → dispatch by `kind` → ack.
 * Malformed bodies are acked (poison); unknown kinds and invalid
 * payloads are acked after a failed projection mark; handler throws
 * mark the run failed and retry the message.
 */
export const makeJobConsumer = (deps: JobConsumerDeps) => {
	const normalize = deps.normalize ?? decodeJobEnvelope;
	const newId = deps.newId ?? (() => crypto.randomUUID());
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
	return async (messages: readonly JobMessageLike[]): Promise<void> => {
		for (const message of messages) {
			const normalized = normalize(message.body);
			if (normalized === null) {
				message.ack();
				continue;
			}
			const id = normalized.id ?? newId();
			const kind = normalized.kind;
			const tenantId = normalized.tenantId ?? null;
			const registration = deps.handlers[kind];
			const envelope: JobEnvelope = { id, kind, payload: normalized.payload, tenantId };
			if (registration === undefined) {
				await mark({ id, kind, status: "failed", error: `unknown job kind: ${kind}`, tenantId });
				message.ack();
				continue;
			}
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
				continue;
			}
			try {
				await registration.handle(payload, envelope);
			} catch (error) {
				await mark({ id, kind, status: "failed", error: String(error), tenantId });
				message.retry();
				continue;
			}
			await mark({ id, kind, status: "done", error: null, tenantId });
			message.ack();
		}
	};
};
