/**
 * Scheduled-job metadata — the single source of truth shared by the
 * deploy target and the runtime registry. `alchemy.run.ts` provisions
 * the worker's cron triggers from {@link CRON_SCHEDULES};
 * `lib/platform.ts` attaches the fire routines (lib/agenda-reminders,
 * lib/audit-chain, the scheduler-heartbeat sweep) keyed by `id`. Keep
 * this module dependency-free —
 * the Alchemy stack imports it outside the worker bundle.
 */
export interface AppCronJob {
	/** Logical id — also the `cron.<id>` job_runs kind suffix. */
	readonly id: string;
	/** Standard 5-field cron expressions that fire this job. */
	readonly schedules: readonly string[];
	readonly description: string;
}

export const APP_CRON_JOBS: readonly AppCronJob[] = [
	{
		id: "scheduler-heartbeat",
		// Runtime scheduler (P-094): every-minute heartbeat that claims
		// due `scheduled_jobs` rows and dispatches them through the jobs
		// backbone. This is the ONLY trigger dynamic schedules need —
		// cron_expr/run_at live in the DB, editable at runtime.
		schedules: ["* * * * *"],
		description:
			"Claim due scheduled_jobs rows (lease-conditional) and dispatch each through the jobs queue.",
	},
	{
		id: "outbox-drain",
		// Same every-minute expression as scheduler-heartbeat — the
		// registry dispatches every job bound to a fired expression, so
		// no extra cron trigger is provisioned. Claims due `outbox`
		// rows (lease-conditional) and delivers them through the
		// registered kind deliverers with retry/backoff.
		schedules: ["* * * * *"],
		description:
			"Claim due outbox rows and deliver them through registered kind deliverers (email) with retry and backoff.",
	},
	{
		id: "agenda-reminders",
		// The reminder sweep also runs on the daily fire — it is cheap
		// and idempotent (reminderSentAt claim), so a missed 5-minute
		// window self-heals at the next daily pass.
		schedules: ["*/5 * * * *", "17 3 * * *"],
		description:
			"Dispatch appointment.reminderDue events for appointments entering their reminder lead window.",
	},
	{
		id: "audit-chain-verify",
		schedules: ["17 3 * * *"],
		description:
			"Walk the tamper-evident audit chain and record a tamper marker row on a broken link.",
	},
];

/** Unique cron expressions the deploy target must provision as
 * triggers — derived, never hand-listed, so adding a schedule to a
 * job above automatically extends the worker's `crons`. */
export const CRON_SCHEDULES: readonly string[] = [
	...new Set(APP_CRON_JOBS.flatMap((job) => job.schedules)),
];
