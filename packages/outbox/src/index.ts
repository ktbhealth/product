import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import * as Context from "effect/Context";

import type { DbClient } from "@ktb/db";
import { outbox } from "@ktb/db/schema";
import { tenantStorageId, type TenantId } from "@ktb/tenant";

/**
 * @ktb/outbox — the reliable-delivery outbox: domain code writes an
 * outbox row (ideally in the same transaction as the domain change)
 * and a drainer delivers it later through kind-registered deliverers
 * with retry + exponential backoff. Built for outbound email first
 * (kind "email"), generic by design — any side effect that must not
 * be lost to an inline `console.error` fits the same shape.
 *
 * Consistency contract (documented caveat): `enqueue` is a separate
 * DB write from the domain mutation — callers that can wrap both in
 * `tx()` (@ktb/db) get true transactional-outbox semantics; callers
 * that can't get "row written, delivery guaranteed afterwards" —
 * never "delivery attempted inline and maybe lost".
 *
 * Lifecycle: `pending` → `done` (deliverer accepted) | `failed`
 * (attempts exhausted). Rows whose `kind` has no registered deliverer
 * stay `pending` — visible, never silently dropped or poison-failed;
 * registering the deliverer later makes them deliverable. Failed
 * attempts back off via `next_attempt_at`; the drainer's lease
 * (`claimed_until`) makes claims atomic across isolates, same
 * contract as @ktb/scheduler-port's scheduled_jobs sweep.
 *
 * Drain triggers: the composition edge runs `drainOutbox` on a cron
 * sweep (durable backstop) and `Outbox.enqueue` kicks a best-effort
 * immediate drain so dev/low-latency paths still deliver promptly —
 * the kick is fire-and-forget; the sweep is the guarantee.
 */

export type OutboxStatus = "pending" | "done" | "failed";

/** Console/service-facing record — `payload` is the decoded JSON. */
export interface OutboxRecord {
	readonly id: string;
	readonly kind: string;
	readonly payload: unknown;
	readonly status: OutboxStatus;
	readonly attempts: number;
	readonly nextAttemptAt: number;
	readonly claimedUntil: number | null;
	readonly error: string | null;
	/** Owning tenant — stored normalized to the integer `tenant_id`
	 * column form; null = personal/global scope. */
	readonly tenantId: TenantId | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Fields accepted on enqueue. `id`/timestamps are generated. */
export interface OutboxWrite {
	readonly id?: string;
	readonly kind: string;
	readonly payload: unknown;
	readonly tenantId?: TenantId | null;
}

export interface OutboxFilter {
	readonly kind?: string;
	readonly status?: OutboxStatus;
	/** undefined = any scope; null = personal scope only; a TenantId =
	 * that tenant (normalized to the integer column form; a non-numeric
	 * string can never match a stored row). */
	readonly tenantId?: TenantId | null;
	readonly limit?: number;
}

const parsePayload = (raw: string): unknown => {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
};

const encodePayload = (payload: unknown): string => JSON.stringify(payload ?? null);

const toRecord = (row: typeof outbox.$inferSelect): OutboxRecord => ({
	id: row.id,
	kind: row.kind,
	payload: parsePayload(row.payload),
	status: row.status as OutboxStatus,
	attempts: row.attempts,
	nextAttemptAt: row.nextAttemptAt,
	claimedUntil: row.claimedUntil,
	error: row.error,
	tenantId: row.tenantId,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

/** Insert a pending outbox row; returns the stored record. */
export const insertOutboxRecord = async (
	db: DbClient,
	write: OutboxWrite,
	now = Date.now(),
	newId: () => string = () => crypto.randomUUID(),
): Promise<OutboxRecord> => {
	if (write.kind.trim().length === 0) throw new Error("outbox kind must be non-empty");
	const id = write.id ?? newId();
	await db.insert(outbox).values({
		id,
		kind: write.kind,
		payload: encodePayload(write.payload),
		status: "pending",
		attempts: 0,
		nextAttemptAt: now,
		claimedUntil: null,
		error: null,
		// tenant_id is an integer column — the wire TenantId normalizes
		// to its storage form (numeric strings → number, non-numeric →
		// null/personal, matching tenantScopeId's stamping contract).
		tenantId: tenantStorageId(write.tenantId ?? null),
		createdAt: now,
		updatedAt: now,
	});
	return {
		id,
		kind: write.kind,
		payload: write.payload ?? null,
		status: "pending",
		attempts: 0,
		nextAttemptAt: now,
		claimedUntil: null,
		error: null,
		tenantId: tenantStorageId(write.tenantId ?? null),
		createdAt: now,
		updatedAt: now,
	};
};

/** Fetch one row by id; null when absent. */
export const getOutboxRecord = async (db: DbClient, id: string): Promise<OutboxRecord | null> => {
	const rows = await db.select().from(outbox).where(eq(outbox.id, id)).limit(1);
	const row = rows[0];
	return row === undefined ? null : toRecord(row);
};

/** Console/admin read: oldest due first, optionally filtered. */
export const listOutboxRecords = async (
	db: DbClient,
	filter: OutboxFilter = {},
): Promise<OutboxRecord[]> => {
	const conditions = [];
	if (filter.kind !== undefined) conditions.push(eq(outbox.kind, filter.kind));
	if (filter.status !== undefined) conditions.push(eq(outbox.status, filter.status));
	if (filter.tenantId !== undefined) {
		if (filter.tenantId === null) {
			conditions.push(isNull(outbox.tenantId));
		} else {
			const stored = tenantStorageId(filter.tenantId);
			// A non-numeric tenant id has no integer storage form — it
			// can never equal a stored tenant_id, so match nothing
			// rather than collapsing onto the personal-scope NULLs.
			conditions.push(stored === null ? sql`1 = 0` : eq(outbox.tenantId, stored));
		}
	}
	const rows = await db
		.select()
		.from(outbox)
		.where(conditions.length === 0 ? undefined : and(...conditions))
		.orderBy(asc(outbox.nextAttemptAt), asc(outbox.id))
		.limit(filter.limit ?? 200);
	return rows.map(toRecord);
};

export interface ClaimDueOutboxOptions {
	/** Sweep instant (epoch ms) — injectable for tests. */
	readonly now?: number;
	/** Claim lease: a row is re-claimable after this long. Default 5min —
	 * comfortably above one drain interval, short enough that a dead
	 * isolate's claims self-heal quickly. */
	readonly leaseMs?: number;
	/** Max rows claimed per drain — bounds sweep work. Default 100. */
	readonly limit?: number;
}

/**
 * Claim every due row for delivery. The UPDATE's WHERE clause re-checks
 * all claim conditions, so concurrent drainers cannot double-claim —
 * RETURNING yields only rows this call actually won.
 */
export const claimDueOutboxRecords = async (
	db: DbClient,
	options: ClaimDueOutboxOptions = {},
): Promise<OutboxRecord[]> => {
	const now = options.now ?? Date.now();
	const leaseMs = options.leaseMs ?? 5 * 60_000;
	const limit = options.limit ?? 100;
	const candidates = await db
		.select({ id: outbox.id })
		.from(outbox)
		.where(
			and(
				eq(outbox.status, "pending"),
				lte(outbox.nextAttemptAt, now),
				or(isNull(outbox.claimedUntil), lt(outbox.claimedUntil, now)),
			),
		)
		.orderBy(asc(outbox.nextAttemptAt), asc(outbox.id))
		.limit(limit);
	if (candidates.length === 0) return [];
	const rows = await db
		.update(outbox)
		.set({ claimedUntil: now + leaseMs, updatedAt: now })
		.where(
			and(
				inArray(
					outbox.id,
					candidates.map((c) => c.id),
				),
				eq(outbox.status, "pending"),
				lte(outbox.nextAttemptAt, now),
				or(isNull(outbox.claimedUntil), lt(outbox.claimedUntil, now)),
			),
		)
		.returning();
	return rows.map(toRecord);
};

/** Release a claim without delivering (unknown kind, drain abort) —
 * fenced on the lease value so a stale release cannot clear a newer
 * claim. */
const releaseOutboxClaim = async (
	db: DbClient,
	id: string,
	claimedUntil: number,
	now: number,
): Promise<void> => {
	await db
		.update(outbox)
		.set({ claimedUntil: null, updatedAt: now })
		.where(and(eq(outbox.id, id), eq(outbox.claimedUntil, claimedUntil)));
};

/** Mark a claimed row delivered. Fenced on the claim lease — a row
 * re-claimed by a newer sweep is left alone. */
const completeOutboxRecord = async (
	db: DbClient,
	id: string,
	claimedUntil: number,
	now: number,
): Promise<void> => {
	await db
		.update(outbox)
		.set({ status: "done", claimedUntil: null, error: null, updatedAt: now })
		.where(and(eq(outbox.id, id), eq(outbox.claimedUntil, claimedUntil)));
};

/** Exponential backoff cap for the next attempt delay. */
const backoffDelay = (attempts: number, baseMs: number, capMs: number): number =>
	Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));

/**
 * Record a failed delivery attempt: attempts+1, error kept (short,
 * caller-provided), claim released, `next_attempt_at` pushed out by
 * exponential backoff. When the attempt budget is exhausted the row
 * flips to terminal `failed` — the operator-visible dead state.
 * Fenced on the claim lease like {@link completeOutboxRecord}.
 */
const failOutboxRecord = async (
	db: DbClient,
	id: string,
	claimedUntil: number,
	error: string,
	now: number,
	maxAttempts: number,
	baseBackoffMs: number,
	maxBackoffMs: number,
): Promise<OutboxStatus> => {
	const rows = await db
		.select({ attempts: outbox.attempts })
		.from(outbox)
		.where(eq(outbox.id, id))
		.limit(1);
	const attempts = (rows[0]?.attempts ?? 0) + 1;
	const exhausted = attempts >= maxAttempts;
	await db
		.update(outbox)
		.set({
			status: exhausted ? "failed" : "pending",
			attempts,
			nextAttemptAt: exhausted ? now : now + backoffDelay(attempts, baseBackoffMs, maxBackoffMs),
			claimedUntil: null,
			error,
			updatedAt: now,
		})
		.where(and(eq(outbox.id, id), eq(outbox.claimedUntil, claimedUntil)));
	return exhausted ? "failed" : "pending";
};

/**
 * One kind's delivery handler. `payload` is the row's decoded JSON —
 * the handler owns its own validation (a decode throw counts as a
 * failed attempt and backs off like any delivery error).
 */
export type OutboxDeliverer = (payload: unknown, record: OutboxRecord) => Promise<void>;

export type OutboxDeliverers = Readonly<Record<string, OutboxDeliverer>>;

/**
 * Kind → deliverer registry for the shared outbox drainer — mirrors
 * `jobHandlers` in @ktb/jobs-port. The composition root (apps/web)
 * registers deliverers at startup; domain code never calls this.
 */
export const outboxDeliverers: Record<string, OutboxDeliverer> = {};

/** Register (or replace) an outbox kind deliverer. Called once at app
 * composition by the owning edge module — never from request paths. */
export const registerOutboxDeliverer = (kind: string, deliverer: OutboxDeliverer): void => {
	outboxDeliverers[kind] = deliverer;
};

export interface OutboxDrainOptions extends ClaimDueOutboxOptions {
	/** Deliverer lookup — defaults to the global {@link outboxDeliverers}
	 * registry; tests inject an explicit map. */
	readonly deliverers?: OutboxDeliverers;
	/** Terminal attempt budget per row (default 8). Only counts failed
	 * handler runs — a kind with no deliverer never attempts and stays
	 * pending. */
	readonly maxAttempts?: number;
	/** First retry delay (default 60s); doubles per attempt. */
	readonly baseBackoffMs?: number;
	/** Backoff ceiling (default 1h). */
	readonly maxBackoffMs?: number;
}

export interface OutboxDrainResult {
	readonly claimed: number;
	/** Deliverer accepted the payload → row done. */
	readonly delivered: number;
	/** Handler threw; row stays pending with backoff (or flips to
	 * `failed` when the attempt budget ran out — counted in `dead`). */
	readonly failed: number;
	/** Rows that exhausted `maxAttempts` this drain. */
	readonly dead: number;
	/** Claimed rows whose kind has no deliverer — released back to
	 * pending untouched (visible, deliverable once registered). */
	readonly skipped: number;
}

/**
 * One drain pass: claim due rows, hand each to its kind's deliverer,
 * settle the row. Per-row failures are captured on the row (status +
 * error + backoff) — the drain itself never throws for expected
 * failures; only the claim query can reject.
 */
export const drainOutbox = async (
	db: DbClient,
	options: OutboxDrainOptions = {},
): Promise<OutboxDrainResult> => {
	const now = options.now ?? Date.now();
	const maxAttempts = options.maxAttempts ?? 8;
	const baseBackoffMs = options.baseBackoffMs ?? 60_000;
	const maxBackoffMs = options.maxBackoffMs ?? 3_600_000;
	const deliverers = options.deliverers ?? outboxDeliverers;
	const claimed = await claimDueOutboxRecords(db, options);
	let delivered = 0;
	let failed = 0;
	let dead = 0;
	let skipped = 0;
	for (const record of claimed) {
		const deliverer = deliverers[record.kind];
		if (deliverer === undefined) {
			// No deliverer registered for this kind — release the claim
			// so the row stays visible as pending instead of dying.
			await releaseOutboxClaim(db, record.id, record.claimedUntil as number, now).catch(() => {});
			skipped += 1;
			continue;
		}
		try {
			await deliverer(record.payload, record);
			await completeOutboxRecord(db, record.id, record.claimedUntil as number, now);
			delivered += 1;
		} catch (error) {
			const detail = String(error instanceof Error ? error.message : error).slice(0, 500);
			const status = await failOutboxRecord(
				db,
				record.id,
				record.claimedUntil as number,
				detail,
				now,
				maxAttempts,
				baseBackoffMs,
				maxBackoffMs,
			);
			failed += 1;
			if (status === "failed") dead += 1;
		}
	}
	return { claimed: claimed.length, delivered, failed, dead, skipped };
};

/**
 * Outbox port: enqueue a `{kind, payload}` record for async delivery.
 * Implementations are composed at the edge (app-host binds the Db).
 */
export interface OutboxShape {
	enqueue(write: OutboxWrite): Promise<OutboxRecord>;
	/** Run one drain pass now (cron sweep / tests). */
	drain(options?: OutboxDrainOptions): Promise<OutboxDrainResult>;
}

/** Effect service face of the port — the value is the outbox itself. */
export class Outbox extends Context.Service<Outbox, OutboxShape>()("@ktb/outbox/Outbox") {}

export interface OutboxDeps extends Omit<OutboxDrainOptions, "now"> {
	readonly db: DbClient;
	readonly newId?: () => string;
	/** Clock for enqueue timestamps — distinct from the drain option's
	 * `now` sweep instant, which is why this interface omits it. */
	readonly now?: () => number;
}

/**
 * Build the outbox service over a DbClient. `enqueue` writes the
 * pending row, then kicks a best-effort immediate drain — delivery
 * stays durable (the row survives a killed kick; the edge's cron
 * sweep retries), while dev and low-traffic paths still send
 * promptly. The kick is fire-and-forget and never fails the enqueue.
 */
export const makeOutbox = (deps: OutboxDeps): OutboxShape => {
	// `deps.now` is a clock for enqueue timestamps; the drain option's
	// `now` is a sweep instant — different shapes, never forwarded.
	const { db, newId, now: clock, ...defaults } = deps;
	// Drains run one at a time: the enqueue kick and explicit drains
	// share a single chain, so a caller's `drain()` can never race an
	// in-flight kick on the same rows. Claims are lease-fenced either
	// way, but serializing keeps ordering deterministic for callers
	// (and tests) that drain right after enqueue.
	let chain: Promise<unknown> = Promise.resolve();
	const drain = (options: OutboxDrainOptions = {}): Promise<OutboxDrainResult> => {
		const run = chain.then(() => drainOutbox(db, { ...defaults, ...options }));
		chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
	return {
		enqueue: async (write) => {
			const record = await insertOutboxRecord(db, write, clock?.() ?? Date.now(), newId);
			void drain().catch(() => {});
			return record;
		},
		drain,
	};
};
