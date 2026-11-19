/**
 * @ktb/cron-port — the cloud-agnostic cron registry: the dispatch
 * contract behind the /platform/cron console and the worker's
 * `scheduled` handler. A cron job here is a NAMED unit of scheduled
 * work the deployment actually wires — never a provider-specific
 * trigger type.
 *
 * Cloudflare Workers fire `scheduled(controller)` once per configured
 * cron expression (Alchemy `crons`); `bun run dev` never fires it, so
 * the same registry backs the console's manual "run now" path — one
 * descriptor list, two transports. Run history is NOT stored here:
 * the composition root projects each fire into `job_runs`
 * (@ktb/jobs-port, kind `cron.<id>`) so the console reads lifecycle
 * through the same transport-agnostic projection as queues.
 */

/** Outcome of one cron fire — the runner records it verbatim. */
export interface CronRunOutcome {
	readonly ok: boolean;
	/** Human-readable one-liner for the console (e.g. "3 reminders dispatched"). */
	readonly summary?: string;
	/** Failure detail when ok is false — kept short, no secrets/PHI. */
	readonly error?: string;
}

/**
 * Static facts plus the fire routine for one scheduled job. A job may
 * declare several cron expressions (e.g. a sweep that runs on the
 * 5-minute trigger AND the daily one); `dispatch` runs it once per
 * matching expression fire.
 */
export interface CronDescriptor {
	/** Logical id (e.g. "agenda-reminders") — also the `cron.<id>` kind suffix. */
	readonly id: string;
	/** Standard 5-field cron expressions that fire this job. */
	readonly schedules: readonly string[];
	readonly description?: string;
	/** The fire routine — MUST be idempotent and must not throw for
	 * expected failures (return `{ ok: false }`); the registry still
	 * catches throws so one bad job never starves the others. */
	readonly run: () => Promise<CronRunOutcome>;
}

/** Console-facing static facts for one registered job. */
export interface CronJobInfo {
	readonly id: string;
	readonly schedules: readonly string[];
	readonly description?: string;
}

/** Per-job result of a dispatch/runNow call. */
export interface CronDispatchResult {
	readonly id: string;
	readonly outcome: CronRunOutcome;
}

export interface CronRegistry {
	/** Every registered job's static facts, registration order. */
	readonly list: () => readonly CronJobInfo[];
	/** Unique cron expressions across all jobs — the set the deploy
	 * target must provision as triggers (Alchemy `crons`). */
	readonly schedules: () => readonly string[];
	/** Fire every job bound to `schedule`; jobs run sequentially so a
	 * slow sweep cannot stampede the isolate. Unknown expressions are
	 * a no-op (empty result). */
	readonly dispatch: (schedule: string) => Promise<readonly CronDispatchResult[]>;
	/** Fire one job by id (console "run now"); null when unknown. */
	readonly runById: (id: string) => Promise<CronDispatchResult | null>;
}

const failure = (error: unknown): CronRunOutcome => ({
	ok: false,
	error: error instanceof Error ? error.message : String(error),
});

const invoke = async (d: CronDescriptor): Promise<CronDispatchResult> => {
	try {
		return { id: d.id, outcome: await d.run() };
	} catch (error) {
		return { id: d.id, outcome: failure(error) };
	}
};

/**
 * Build the registry from composition-time descriptors. Duplicate ids
 * keep the FIRST registration (later ones are ignored — a plugin
 * re-declaring a host job must not hijack its trigger).
 */
export const makeCronRegistry = (descriptors: readonly CronDescriptor[]): CronRegistry => {
	const jobs = new Map<string, CronDescriptor>();
	for (const d of descriptors) {
		if (!jobs.has(d.id)) jobs.set(d.id, d);
	}
	const all = [...jobs.values()];
	return {
		list: () => all.map((d) => ({ id: d.id, schedules: d.schedules, description: d.description })),
		schedules: () => [...new Set(all.flatMap((d) => d.schedules))],
		dispatch: async (schedule) => {
			const matching = all.filter((d) => d.schedules.includes(schedule));
			const results: CronDispatchResult[] = [];
			for (const d of matching) results.push(await invoke(d));
			return results;
		},
		runById: async (id) => {
			const d = jobs.get(id);
			return d === undefined ? null : invoke(d);
		},
	};
};
