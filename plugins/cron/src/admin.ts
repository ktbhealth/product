import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Forbidden } from "@ktb/authz";
import { Db } from "@ktb/db";
import { listJobRuns, type JobRecord } from "@ktb/jobs-port";
import { PlatformAdmin } from "@ktb/platform";
import { getServerRuntime, type CronJobInfo, type CronRunResult } from "@ktb/server-fns";

/**
 * Cron console port: the read/run side of /platform/cron.
 *
 * - `jobs`: the host-published cron registry — every scheduled job
 *   with its cron expressions, description and latest `cron.<id>`
 *   job_runs projection row. Null when the runtime cannot report.
 * - `runs`: recent `cron.*` job_runs rows, newest first — the run
 *   history feed. Null when the projection is unreadable.
 * - `runNow`: fire one job by id through the same registry path the
 *   worker's `scheduled` handler uses — projection included.
 *
 * Every method re-checks PlatformAdmin — defense in depth on top of
 * the page guard, same contract as plugins/queue.
 */
export type CronRunNowResult =
	| { readonly ok: true; readonly summary?: string }
	| {
			readonly ok: false;
			readonly reason: "forbidden" | "unavailable" | "unknown-job" | "run-failed";
			readonly error?: string;
	  };

export class CronAdmin extends Context.Service<
	CronAdmin,
	{
		readonly jobs: () => Effect.Effect<readonly CronJobInfo[] | null, Forbidden>;
		readonly runs: () => Effect.Effect<readonly JobRecord[] | null, Forbidden>;
		readonly runNow: (id: string) => Effect.Effect<CronRunNowResult, Forbidden>;
	}
>()("@ktb/cron/CronAdmin") {}

export const CronAdminLive = Layer.effect(
	CronAdmin,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		return CronAdmin.of({
			jobs: () =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						Effect.promise(async (): Promise<readonly CronJobInfo[] | null> => {
							try {
								const read = getServerRuntime().crons;
								return read === undefined ? null : await read.list();
							} catch {
								return null;
							}
						}),
					),
				),
			runs: () =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						// Same degradation contract as `jobs`: a projection
						// read failure collapses to null → the view renders
						// the unavailable state instead of failing the page.
						Effect.promise(async () => {
							try {
								return await listJobRuns(db, { kindPrefix: "cron.", limit: 100 });
							} catch {
								return null;
							}
						}),
					),
				),
			runNow: (id) =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						Effect.promise(async (): Promise<CronRunNowResult> => {
							let crons: NonNullable<ReturnType<typeof getServerRuntime>["crons"]>;
							try {
								const capability = getServerRuntime().crons;
								if (capability === undefined) return { ok: false, reason: "unavailable" };
								crons = capability;
							} catch {
								return { ok: false, reason: "unavailable" };
							}
							let result: CronRunResult | null;
							try {
								result = await crons.runNow(id);
							} catch {
								return { ok: false, reason: "run-failed", error: "dispatch failed" };
							}
							if (result === null) return { ok: false, reason: "unknown-job" };
							return result.ok
								? { ok: true, summary: result.summary }
								: { ok: false, reason: "run-failed", error: result.error };
						}),
					),
				),
		});
	}),
);
