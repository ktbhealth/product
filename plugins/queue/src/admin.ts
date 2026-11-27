import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Forbidden } from "@ktb/authz";
import { Db } from "@ktb/db";
import { jobHandlers, listJobRuns, type JobRecord, type JobStatus } from "@ktb/jobs-port";
import { PlatformAdmin } from "@ktb/platform";
import { runtimeProbe, type QueueInfo } from "@ktb/server-fns";

/**
 * Queue console port: the read/enqueue side of /platform/queue.
 *
 * - `queues`: the host-published registry probe (every bound transport
 *   with best-effort depth) — null when the runtime cannot report.
 * - `jobRuns`: the transport-agnostic `job_runs` projection, newest
 *   first, optionally filtered by kind/status.
 * - `kinds`: job kinds the consumer registry knows plus the built-in
 *   `jobs.ping` smoke kind — the enqueue picker's options.
 * - `enqueue`: admin test-enqueue through the host's Jobs enqueuer
 *   (writes job_runs, then sends on the bound transport).
 *
 * Every method re-checks PlatformAdmin — defense in depth on top of
 * the page guard, same contract as plugins/jobs Ops.
 */
export interface QueueRunFilter {
	readonly kind?: string;
	readonly status?: JobStatus;
}

export type EnqueueJobResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "forbidden" | "unavailable" | "enqueue-failed";
	  };

export class QueueAdmin extends Context.Service<
	QueueAdmin,
	{
		readonly queues: () => Effect.Effect<readonly QueueInfo[] | null, Forbidden>;
		readonly jobRuns: (
			filter?: QueueRunFilter,
		) => Effect.Effect<readonly JobRecord[] | null, Forbidden>;
		readonly kinds: () => Effect.Effect<readonly string[], Forbidden>;
		readonly enqueue: (
			kind: string,
			payload?: unknown,
		) => Effect.Effect<EnqueueJobResult, Forbidden>;
	}
>()("@ktb/queue/QueueAdmin") {}

/** Registered consumer kinds + the built-in smoke kind, sorted. The
 * registry is populated at composition time; `jobs.ping` is registered
 * by apps/jobs-worker only, so it is added explicitly for the picker. */
export const knownJobKinds = (): readonly string[] =>
	[...new Set([...Object.keys(jobHandlers), "jobs.ping"])].sort();

export const QueueAdminLive = Layer.effect(
	QueueAdmin,
	Effect.gen(function* () {
		const db = yield* Db;
		const platformAdmin = yield* PlatformAdmin;
		return QueueAdmin.of({
			queues: () =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						Effect.promise(async (): Promise<readonly QueueInfo[] | null> => {
							try {
								const read = runtimeProbe((r) => r.queues);
								return read === undefined ? null : await read();
							} catch {
								return null;
							}
						}),
					),
				),
			jobRuns: (filter) =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						// Same degradation contract as `queues`: a projection
						// read failure collapses to null → the view renders
						// the unavailable state instead of failing the page.
						Effect.promise(async () => {
							try {
								return await listJobRuns(db, {
									kind: filter?.kind,
									status: filter?.status,
									limit: 100,
								});
							} catch {
								return null;
							}
						}),
					),
				),
			kinds: () => platformAdmin.requireAdmin().pipe(Effect.as(knownJobKinds())),
			enqueue: (kind, payload) =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						Effect.promise(async (): Promise<EnqueueJobResult> => {
							const jobs = runtimeProbe((r) => r.jobs);
							if (jobs === undefined) return { ok: false, reason: "unavailable" };
							try {
								await jobs.enqueue(kind, payload ?? {});
								return { ok: true };
							} catch {
								return { ok: false, reason: "enqueue-failed" };
							}
						}),
					),
				),
		});
	}),
);
