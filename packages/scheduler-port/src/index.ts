import { Cron } from "croner";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { DbClient } from "@ktb/db";
import { tenantStorageId, type TenantId } from "@ktb/tenant";

import { scheduledJobs } from "./schema.ts";

/**
 * @ktb/scheduler-port — the runtime scheduler: DB-backed schedule
 * definitions (`scheduled_jobs`) claimed and dispatched by a periodic
 * heartbeat sweep. Cloudflare cron triggers are deploy-time infra, so
 * "dynamic cron" here means a fixed heartbeat expression evaluated
 * against a table — schedules are created/edited at runtime with no
 * redeploy and no provider API calls.
 *
 * Dispatch contract: the sweep CLAIMS due rows (lease-conditional
 * UPDATE — the claim is the lock, safe across isolates) then hands
 * each row to a `dispatch` callback. The composition root adapts that
 * callback onto @ktb/jobs-port so scheduled work rides the same
 * queue/retry/job_runs path as enqueued jobs — this package stays
 * transport-agnostic.
 *
 * Schedule model: exactly one of `cronExpr` (recurring, standard
 * 5-field UTC) or `runAt` (one-off epoch ms) per row. `nextRunAt` is
 * always precomputed — the sweep is an indexed range scan and never
 * evaluates cron expressions on the hot path.
 */

export type ScheduledJobStatus = "active" | "paused" | "done";

/** Console/service-facing record — `params` is the decoded JSON payload. */
export interface ScheduledJob {
	readonly id: string;
	readonly kind: string;
	readonly params: unknown;
	readonly cronExpr: string | null;
	readonly runAt: number | null;
	readonly nextRunAt: number;
	readonly claimedUntil: number | null;
	readonly lastRunAt: number | null;
	readonly status: ScheduledJobStatus;
	/** Owning tenant (@ktb/tenant TenantId) — stored normalized to the
	 * integer `tenant_id` column form; null = global scope. */
	readonly tenantId: TenantId | null;
	readonly createdBy: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Fields accepted on insert. `id`/`createdAt`/`updatedAt` are
 * generated; `nextRunAt` is derived from the schedule fields. */
export interface ScheduledJobWrite {
	readonly id?: string;
	readonly kind: string;
	readonly params?: unknown;
	readonly cronExpr?: string | null;
	readonly runAt?: number | null;
	readonly status?: ScheduledJobStatus;
	readonly tenantId?: TenantId | null;
	readonly createdBy?: string | null;
}

/** Mutable fields on update — schedule changes recompute `nextRunAt`. */
export interface ScheduledJobPatch {
	readonly params?: unknown;
	readonly cronExpr?: string | null;
	readonly runAt?: number | null;
	readonly status?: ScheduledJobStatus;
}

export interface ScheduledJobFilter {
	readonly status?: ScheduledJobStatus;
	readonly kind?: string;
	/** undefined = any scope; null = global scope only; a TenantId =
	 * that tenant (normalized to the integer column form; a non-numeric
	 * string can never match a stored row). */
	readonly tenantId?: TenantId | null;
	readonly limit?: number;
}

export class InvalidScheduleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidScheduleError";
	}
}

const FIVE_FIELD = /^\S+(?:\s+\S+){4}$/;

/** Next fire time strictly after `from` for a 5-field cron expression;
 * null when the expression is invalid or has no future occurrence
 * within croner's horizon. Throws InvalidScheduleError on malformed
 * input — callers validating user input should catch it. */
export const nextRunAfter = (cronExpr: string, from: number): number | null => {
	if (!FIVE_FIELD.test(cronExpr)) {
		throw new InvalidScheduleError(`cron expression must have exactly 5 fields: ${cronExpr}`);
	}
	let next: Date | null;
	try {
		next = new Cron(cronExpr).nextRun(new Date(from));
	} catch (error) {
		throw new InvalidScheduleError(
			`invalid cron expression ${cronExpr}: ${error instanceof Error ? error.message : /* v8 ignore next -- croner only throws Error */ String(error)}`,
		);
	}
	return next === null ? null : next.getTime();
};

/** Validate the schedule half of a write/patch: exactly one of
 * cronExpr/runAt, cronExpr parseable, runAt a finite epoch ms. Returns
 * the derived `nextRunAt` or throws InvalidScheduleError. */
export const deriveNextRunAt = (
	cronExpr: string | null,
	runAt: number | null,
	now: number,
): number => {
	const hasCron = cronExpr !== null && cronExpr !== "";
	const hasRunAt = runAt !== null;
	if (hasCron === hasRunAt) {
		throw new InvalidScheduleError("exactly one of cronExpr or runAt must be set");
	}
	if (hasCron) {
		const next = nextRunAfter(cronExpr as string, now);
		if (next === null) throw new InvalidScheduleError(`cron expression never fires: ${cronExpr}`);
		return next;
	}
	if (!Number.isFinite(runAt)) throw new InvalidScheduleError("runAt must be a finite epoch ms");
	// A past runAt fires on the next sweep — deliberate catch-up, not an error.
	return runAt as number;
};

const parseParams = (raw: string | null): unknown => {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
};

const encodeParams = (params: unknown): string | null =>
	params === undefined || params === null ? null : JSON.stringify(params);

const toRecord = (row: typeof scheduledJobs.$inferSelect): ScheduledJob => ({
	id: row.id,
	kind: row.kind,
	params: parseParams(row.params),
	cronExpr: row.cronExpr,
	runAt: row.runAt,
	nextRunAt: row.nextRunAt,
	claimedUntil: row.claimedUntil,
	lastRunAt: row.lastRunAt,
	status: row.status as ScheduledJobStatus,
	tenantId: row.tenantId,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

/** Insert a schedule row; derives `nextRunAt` from the schedule fields. */
export const insertScheduledJob = async (
	db: DbClient,
	write: ScheduledJobWrite,
	now = Date.now(),
): Promise<ScheduledJob> => {
	if (write.kind.trim().length === 0) throw new InvalidScheduleError("kind must be non-empty");
	// "" normalizes to null — deriveNextRunAt already treats it as unset,
	// and a stored "" would read as recurring at claim time.
	const cronExpr = write.cronExpr || null;
	const runAt = write.runAt ?? null;
	const nextRunAt = deriveNextRunAt(cronExpr, runAt, now);
	const id = write.id ?? crypto.randomUUID();
	const status = write.status ?? "active";
	await db.insert(scheduledJobs).values({
		id,
		kind: write.kind,
		params: encodeParams(write.params),
		cronExpr,
		runAt,
		nextRunAt,
		status,
		// tenant_id is an integer column — the wire TenantId normalizes
		// to its storage form (numeric strings → number, non-numeric →
		// null/global, matching tenantScopeId's stamping contract).
		tenantId: tenantStorageId(write.tenantId ?? null),
		createdBy: write.createdBy ?? null,
		createdAt: now,
		updatedAt: now,
	});
	return {
		id,
		kind: write.kind,
		params: write.params ?? null,
		cronExpr,
		runAt,
		nextRunAt,
		claimedUntil: null,
		lastRunAt: null,
		status,
		tenantId: tenantStorageId(write.tenantId ?? null),
		createdBy: write.createdBy ?? null,
		createdAt: now,
		updatedAt: now,
	};
};

/** Fetch one row by id; null when absent. */
export const getScheduledJob = async (db: DbClient, id: string): Promise<ScheduledJob | null> => {
	const rows = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).limit(1);
	const row = rows[0];
	return row === undefined ? null : toRecord(row);
};

/** Console/admin read: newest first, optionally filtered. */
export const listScheduledJobs = async (
	db: DbClient,
	filter: ScheduledJobFilter = {},
): Promise<ScheduledJob[]> => {
	const conditions = [];
	if (filter.status !== undefined) conditions.push(eq(scheduledJobs.status, filter.status));
	if (filter.kind !== undefined) conditions.push(eq(scheduledJobs.kind, filter.kind));
	if (filter.tenantId !== undefined) {
		if (filter.tenantId === null) {
			conditions.push(isNull(scheduledJobs.tenantId));
		} else {
			const stored = tenantStorageId(filter.tenantId);
			// A non-numeric tenant id has no integer storage form — it
			// can never equal a stored tenant_id, so match nothing
			// rather than collapsing onto the global-scope NULLs.
			conditions.push(stored === null ? sql`1 = 0` : eq(scheduledJobs.tenantId, stored));
		}
	}
	const rows = await db
		.select()
		.from(scheduledJobs)
		.where(conditions.length === 0 ? undefined : and(...conditions))
		.orderBy(asc(scheduledJobs.nextRunAt), asc(scheduledJobs.id))
		.limit(filter.limit ?? 200);
	return rows.map(toRecord);
};

/**
 * Patch a row. Schedule-field changes recompute `nextRunAt` against
 * `now`; a `runAt` reschedule into the past fires on the next sweep.
 * Status transitions keep the schedule intact — pausing freezes
 * `nextRunAt`, resuming re-derives it so a stale past timestamp does
 * not burst-fire missed occurrences (coalesce: next sweep sees one
 * due row, fires once).
 */
export const updateScheduledJob = async (
	db: DbClient,
	id: string,
	patch: ScheduledJobPatch,
	now = Date.now(),
): Promise<ScheduledJob | null> => {
	const existing = await getScheduledJob(db, id);
	if (existing === null) return null;
	const cronExpr = (patch.cronExpr !== undefined ? patch.cronExpr : existing.cronExpr) || null;
	const runAt = patch.runAt !== undefined ? (patch.runAt ?? null) : existing.runAt;
	const scheduleChanged =
		patch.cronExpr !== undefined || patch.runAt !== undefined || patch.status === "active";
	const nextRunAt = scheduleChanged ? deriveNextRunAt(cronExpr, runAt, now) : existing.nextRunAt;
	const status = patch.status ?? existing.status;
	await db
		.update(scheduledJobs)
		.set({
			params: patch.params !== undefined ? encodeParams(patch.params) : undefined,
			cronExpr,
			runAt,
			nextRunAt,
			status,
			updatedAt: now,
		})
		.where(eq(scheduledJobs.id, id));
	return getScheduledJob(db, id);
};

/** Delete a row; true when a row was removed. */
export const deleteScheduledJob = async (db: DbClient, id: string): Promise<boolean> => {
	const rows = await db
		.delete(scheduledJobs)
		.where(eq(scheduledJobs.id, id))
		.returning({ id: scheduledJobs.id });
	return rows.length > 0;
};

export interface ClaimDueOptions {
	/** Sweep instant (epoch ms) — injectable for tests. */
	readonly now?: number;
	/** Claim lease: a row is re-claimable after this long. Default 5min —
	 * comfortably above one heartbeat interval, short enough that a
	 * dead isolate's claims self-heal quickly. */
	readonly leaseMs?: number;
	/** Max rows claimed per sweep — bounds heartbeat work. Default 100. */
	readonly limit?: number;
}

/**
 * Claim every due row for firing. The UPDATE's WHERE clause re-checks
 * all claim conditions, so concurrent sweepers cannot double-claim —
 * RETURNING yields only rows this call actually won. Recurring rows
 * get `nextRunAt` recomputed from `now` (missed occurrences coalesce
 * into one fire); one-off rows flip to `done`.
 */
export const claimDueScheduledJobs = async (
	db: DbClient,
	options: ClaimDueOptions = {},
): Promise<ScheduledJob[]> => {
	const now = options.now ?? Date.now();
	const leaseMs = options.leaseMs ?? 5 * 60_000;
	const limit = options.limit ?? 100;
	const candidates = await db
		.select()
		.from(scheduledJobs)
		.where(
			and(
				eq(scheduledJobs.status, "active"),
				lte(scheduledJobs.nextRunAt, now),
				or(isNull(scheduledJobs.claimedUntil), lt(scheduledJobs.claimedUntil, now)),
			),
		)
		.orderBy(asc(scheduledJobs.nextRunAt), asc(scheduledJobs.id))
		.limit(limit);
	const claimed: ScheduledJob[] = [];
	for (const candidate of candidates) {
		const isRecurring = candidate.cronExpr !== null && candidate.cronExpr !== "";
		let nextRunAt: number | null = null;
		if (isRecurring) {
			try {
				nextRunAt = nextRunAfter(candidate.cronExpr as string, now);
			} catch {
				nextRunAt = null;
			}
		}
		if (isRecurring && nextRunAt === null) {
			// Expression exhausted (no future occurrence) — retire the row
			// rather than firing it forever. Same claim conditions as the
			// claim UPDATE so a concurrent pause/claim is never clobbered.
			await db
				.update(scheduledJobs)
				.set({ status: "done", updatedAt: now })
				.where(
					and(
						eq(scheduledJobs.id, candidate.id),
						eq(scheduledJobs.status, "active"),
						lte(scheduledJobs.nextRunAt, now),
						or(isNull(scheduledJobs.claimedUntil), lt(scheduledJobs.claimedUntil, now)),
					),
				);
			continue;
		}
		const rows = await db
			.update(scheduledJobs)
			.set({
				claimedUntil: now + leaseMs,
				nextRunAt: isRecurring ? (nextRunAt as number) : candidate.nextRunAt,
				lastRunAt: now,
				status: isRecurring ? "active" : "done",
				updatedAt: now,
			})
			.where(
				and(
					eq(scheduledJobs.id, candidate.id),
					eq(scheduledJobs.status, "active"),
					lte(scheduledJobs.nextRunAt, now),
					or(isNull(scheduledJobs.claimedUntil), lt(scheduledJobs.claimedUntil, now)),
				),
			)
			.returning();
		if (rows[0] !== undefined) claimed.push(toRecord(rows[0]));
	}
	return claimed;
};

/** What the sweep hands each claimed row to — the composition root
 * adapts this onto @ktb/jobs-port enqueue (or an inline fallback when
 * no queue transport is bound). */
export type ScheduledJobDispatch = (job: ScheduledJob) => Promise<unknown>;

export interface SchedulerSweepResult {
	readonly claimed: number;
	readonly fired: number;
	readonly failed: number;
}

/**
 * Release a claim once its dispatch attempt settles. The lease only
 * needs to cover the claim→dispatch window — holding it for the full
 * `leaseMs` would throttle recurring schedules more frequent than the
 * lease (a `* * * * *` job would fire once per lease window instead of
 * once per minute). Fenced on the lease value this sweep wrote, so a
 * stale release cannot clear a newer claim.
 */
const releaseScheduledJobClaim = async (
	db: DbClient,
	id: string,
	claimedUntil: number,
): Promise<void> => {
	await db
		.update(scheduledJobs)
		.set({ claimedUntil: null })
		.where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.claimedUntil, claimedUntil)));
};

/**
 * Fire one active row immediately (console "run now"): claims it with
 * the same lease semantics as the sweep — the schedule still advances
 * (recurring rows recompute `nextRunAt` from now, one-offs flip to
 * done) so an early manual fire never double-fires the occurrence.
 * Returns null when the row is missing, not active, or mid-claim.
 * Dispatch errors are captured on the result — the schedule already
 * advanced, so they surface as data, not throws.
 */
export const runScheduledJobNow = async (
	db: DbClient,
	id: string,
	dispatch: ScheduledJobDispatch,
	options: ClaimDueOptions = {},
): Promise<{ readonly job: ScheduledJob; readonly error: string | null } | null> => {
	const now = options.now ?? Date.now();
	const leaseMs = options.leaseMs ?? 5 * 60_000;
	const existing = await getScheduledJob(db, id);
	if (existing === null || existing.status !== "active") return null;
	if (existing.claimedUntil !== null && existing.claimedUntil > now) return null;
	const isRecurring = existing.cronExpr !== null;
	let nextRunAt: number | null = null;
	if (isRecurring) {
		try {
			nextRunAt = nextRunAfter(existing.cronExpr as string, now);
		} catch {
			nextRunAt = null;
		}
	}
	if (isRecurring && nextRunAt === null) {
		await db
			.update(scheduledJobs)
			.set({ status: "done", updatedAt: now })
			.where(eq(scheduledJobs.id, id));
		return null;
	}
	const rows = await db
		.update(scheduledJobs)
		.set({
			claimedUntil: now + leaseMs,
			nextRunAt: isRecurring ? (nextRunAt as number) : existing.nextRunAt,
			lastRunAt: now,
			status: isRecurring ? "active" : "done",
			updatedAt: now,
		})
		.where(
			and(
				eq(scheduledJobs.id, id),
				eq(scheduledJobs.status, "active"),
				or(isNull(scheduledJobs.claimedUntil), lt(scheduledJobs.claimedUntil, now)),
			),
		)
		.returning();
	const row = rows[0];
	if (row === undefined) return null;
	const job = toRecord(row);
	try {
		await dispatch(job);
		return { job, error: null };
	} catch (error) {
		return { job, error: error instanceof Error ? error.message : String(error) };
	}
};

/**
 * One heartbeat pass: claim due rows, dispatch each, release each
 * claim. A dispatch failure does not retry the occurrence — the
 * schedule already advanced (a recurring row fires again at its next
 * occurrence; a one-off is done). The failure surfaces through the
 * dispatch path's own projection (job_runs when enqueued) and the
 * returned count; the sweep itself never throws for expected failures.
 */
export const runSchedulerSweep = async (
	db: DbClient,
	dispatch: ScheduledJobDispatch,
	options: ClaimDueOptions = {},
): Promise<SchedulerSweepResult> => {
	const claimed = await claimDueScheduledJobs(db, options);
	let fired = 0;
	let failed = 0;
	for (const job of claimed) {
		try {
			await dispatch(job);
			fired += 1;
		} catch {
			failed += 1;
		} finally {
			// Release the lease so the next occurrence isn't throttled to
			// leaseMs. A release failure only delays the row until lease
			// expiry — never fails the sweep.
			await releaseScheduledJobClaim(db, job.id, job.claimedUntil as number).catch(
				(error: unknown) => {
					console.warn("scheduled job claim release failed", {
						id: job.id,
						error: String(error),
					});
				},
			);
		}
	}
	return { claimed: claimed.length, fired, failed };
};
