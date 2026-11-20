/**
 * `@ktb/scheduler-do` — Durable Object scheduler for precise one-off
 * `scheduled_jobs` run_at times (P-094).
 *
 * The `* * * * *` heartbeat (scheduler-heartbeat cron) sweeps due rows
 * at minute granularity — cheap, but coarse. This DO is the precision
 * backstop: `setAlarm(runAt)` fires the sweep at the exact instant.
 *
 * Contract:
 * - The DO owns ONLY timing — it never executes job logic and never
 *   writes schedule state. On alarm it delegates to
 *   `runSchedulerSweep` (same lease-claim path as the heartbeat), then
 *   dispatch goes through the jobs queue.
 * - Pending one-off times live in DO storage (`pending` map). Mutations
 *   arrive over HTTP fetch; the worker notifies via
 *   `idFromName("global")` — one instance coordinates all schedules.
 * - Fire semantics are at-least-once and idempotent: the sweep's
 *   lease-claim + jobs-port envelope dedupe mean a missed, retried, or
 *   duplicated alarm can never double-fire a schedule.
 * - If the DO is absent/unreachable, the heartbeat still fires every
 *   due row within ~1 minute — the DO is an accelerator, never a
 *   dependency.
 */
import { makeDb, type SqlDatabase } from "@ktb/db";
import { makeJobs, type JobEnvelope } from "@ktb/jobs-port";
import { runSchedulerSweep, type ScheduledJobDispatch } from "@ktb/scheduler-port";

/** Cloudflare DurableObjectState — narrowed to what the DO uses so
 * tests can fake it. `blockConcurrencyWhile` is unused (no
 * constructor-time init). */
export interface SchedulerDoState {
	readonly storage: {
		get<T = unknown>(key: string): Promise<T | undefined>;
		put(key: string, value: unknown): Promise<void>;
		setAlarm(scheduledTime: number | Date): Promise<void>;
		deleteAlarm(): Promise<void>;
	};
}

/** Queue binding shape the DO dispatches through (structural). */
export interface SchedulerQueueBinding {
	send(body: unknown, options?: unknown): Promise<unknown>;
}

/** Worker env the DO reads — bindings arrive untyped from workerd. */
export interface SchedulerDoEnv {
	readonly DB?: SqlDatabase;
	readonly AUDIO_QUEUE?: SchedulerQueueBinding;
}

const PENDING_KEY = "pending";
const DO_INSTANCE = "global";

/** Pending one-off run times: scheduled_jobs.id → epoch ms. */
type PendingRuns = Record<string, number>;

/** Cloudflare Durable Object class — exported and bound as
 * `SCHEDULER`. */
export class SchedulerDo {
	constructor(
		private readonly state: SchedulerDoState,
		private readonly env: SchedulerDoEnv,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/schedule") {
			return this.handleSchedule(request);
		}
		if (request.method === "POST" && url.pathname === "/unschedule") {
			return this.handleUnschedule(request);
		}
		if (request.method === "GET" && url.pathname === "/state") {
			return Response.json({
				pending: await this.pending(),
				alarm: await this.nextAlarm(),
			});
		}
		return new Response("not found", { status: 404 });
	}

	/** DO alarm handler — run the lease-claim sweep, then re-arm for
	 * the next pending run_at. At-least-once + idempotent: a retried
	 * alarm just re-sweeps; the lease claim prevents double-fire. */
	async alarm(): Promise<void> {
		const db = this.env.DB === undefined ? undefined : makeDb(this.env.DB);
		const queue = this.env.AUDIO_QUEUE;
		if (db && queue) {
			// send must reject on transport failure — makeJobs marks the
			// job_runs row failed and rethrows so dispatch reports it.
			const jobs = makeJobs({
				send: (envelope: JobEnvelope) => queue.send(envelope),
				db,
			});
			const dispatch: ScheduledJobDispatch = (job) =>
				jobs.enqueue(job.kind, job.params ?? {}, { tenantId: job.tenantId }).then(() => undefined);
			await runSchedulerSweep(db, dispatch).catch(() => ({
				claimed: 0,
				fired: 0,
				failed: 0,
			}));
		}
		await this.reschedule();
	}

	/** Record a one-off run time and arm the alarm for the earliest
	 * pending entry. */
	private async handleSchedule(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			id?: unknown;
			runAt?: unknown;
		} | null;
		const id = typeof body?.id === "string" ? body.id : null;
		const runAt =
			typeof body?.runAt === "number" && Number.isFinite(body.runAt) ? body.runAt : null;
		if (!id || runAt === null) {
			return Response.json({ error: "id and runAt (epoch ms) required" }, { status: 400 });
		}
		const pending = await this.pending();
		pending[id] = runAt;
		await this.state.storage.put(PENDING_KEY, pending);
		await this.arm();
		return Response.json({ ok: true, pending: { [id]: runAt } });
	}

	/** Drop a pending entry (schedule deleted/paused) and re-arm. */
	private async handleUnschedule(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as {
			id?: unknown;
		} | null;
		const id = typeof body?.id === "string" ? body.id : null;
		if (!id) {
			return Response.json({ error: "id required" }, { status: 400 });
		}
		const pending = await this.pending();
		delete pending[id];
		await this.state.storage.put(PENDING_KEY, pending);
		await this.arm();
		return Response.json({ ok: true });
	}

	private async pending(): Promise<PendingRuns> {
		return (await this.state.storage.get<PendingRuns>(PENDING_KEY)) ?? {};
	}

	/** Earliest armed alarm time, for /state diagnostics. */
	private async nextAlarm(): Promise<number | null> {
		const pending = await this.pending();
		const times = Object.values(pending);
		return times.length === 0 ? null : Math.min(...times);
	}

	/** Arm the alarm at the earliest pending run_at (or clear it). */
	private async arm(): Promise<void> {
		const next = await this.nextAlarm();
		if (next === null) {
			await this.state.storage.deleteAlarm();
		} else {
			await this.state.storage.setAlarm(next);
		}
	}

	/** After a fire: drop entries whose run_at has passed (the sweep
	 * already claimed them), then re-arm for the next pending time. */
	private async reschedule(): Promise<void> {
		const now = Date.now();
		const pending = await this.pending();
		let changed = false;
		for (const [id, runAt] of Object.entries(pending)) {
			if (runAt <= now) {
				delete pending[id];
				changed = true;
			}
		}
		if (changed) {
			await this.state.storage.put(PENDING_KEY, pending);
		}
		await this.arm();
	}
}

/** Structural view of a DurableObjectNamespace — the worker env
 * carries the real binding; tests fake it. */
export interface SchedulerDoNamespace {
	idFromName(name: string): { toString(): string };
	get(id: { toString(): string }): { fetch(request: Request): Promise<Response> };
}

/** Notify the scheduler DO of a schedule mutation. Fire-and-forget by
 * contract — the heartbeat covers any missed notification, so callers
 * may await or drop the promise. Returns silently when the binding is
 * absent (dev/preview environments without the DO). */
export async function notifySchedulerDo(
	namespace: SchedulerDoNamespace | undefined,
	path: "/schedule" | "/unschedule",
	body: { id: string; runAt?: number },
): Promise<void> {
	if (!namespace) return;
	try {
		const stub = namespace.get(namespace.idFromName(DO_INSTANCE));
		await stub.fetch(
			new Request(`https://scheduler-do${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	} catch {
		// The DO is a timing accelerator only — a failed notify must
		// never break a schedule write; the heartbeat is the backstop.
	}
}
