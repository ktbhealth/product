import type { DbClient } from "@ktb/db";
import { packageLive, type Plugin } from "@ktb/kernel";
import {
	collectEventTopicDeclarations,
	collectJobKindDeclarations,
	collectSchedulableDeclarations,
} from "@ktb/platform/capabilities";
import { PluginStates } from "@ktb/platform/plugin-states";
import {
	dispatchJobInline,
	listJobRuns,
	upsertJobRun,
	type JobHandlerRegistry,
	type JobRecord,
	type JobStatus,
	type JobsEnqueuer,
} from "@ktb/jobs-port";
import {
	makeCronRegistry,
	type CronDescriptor,
	type CronDispatchResult,
	type CronRunOutcome,
} from "@ktb/cron-port";
import {
	deleteScheduledJob,
	insertScheduledJob,
	InvalidScheduleError,
	listScheduleEntries,
	listScheduledJobs,
	runScheduledJobNow,
	updateScheduledJob,
	type ScheduleEntry,
	type ScheduledJob,
	type ScheduledJobDispatch,
} from "@ktb/scheduler-port";
import { notifySchedulerDo, type SchedulerDoNamespace } from "@ktb/scheduler-do";
import { makeQueueRegistry, type QueueDescriptor } from "@ktb/queues-port";
import {
	makeInProcessPubSub,
	mergePubSubSources,
	type PubSubBus,
	type PubSubTopicSource,
} from "@ktb/pubsub-port";
import {
	audioStorageStats,
	type AudioObjectLister,
	type AudioQueueSender,
	type AudioStore,
	type JsonValue,
	type QueueDepth,
	type ScheduleEntryInfo,
	type ScheduledJobInfo,
	type ServerRuntime,
} from "@ktb/server-fns";
import * as Effect from "effect/Effect";

import {
	compileSchedulableValidators,
	eventTopicInfos,
	jobKindInfos,
	scheduleKindDispatchable,
	scheduleParamsError,
	schedulableKindInfos,
} from "./platform-capabilities.ts";

/**
 * server-runtime.ts — the generic ServerRuntime capability block,
 * extracted from the app composition root (apps/web lib/platform.ts).
 * Everything here is host machinery any composition root needs
 * identically: queue/cron/schedule/pubsub console probes, job-kind and
 * capability-declaration views, the plugin-state probe, and the
 * scheduled-job write surface. Deploy-bound values (env bindings,
 * app-owned cron runners, i18n/auth/AI wiring) arrive as deps — the
 * factory never reads provider env itself beyond the binding bag the
 * edge hands it.
 */

/** Static facts of one deploy-time cron job — the app supplies the
 * list (its `scheduled` triggers are provisioned from the same data)
 * and the fire routines keyed by id. */
export interface ServerRuntimeCronJob {
	readonly id: string;
	readonly schedules: readonly string[];
	readonly description?: string;
}

export interface ServerRuntimeDeps {
	/** Raw binding bag from the deploy edge (the app's resolved env
	 * record). The factory reads only the bindings it composes —
	 * buckets, queue producers, pub/sub transports, DO namespaces. */
	readonly env: Record<string, unknown>;
	/** The composed app's DbClient — job_runs/scheduled_jobs
	 * projections share it. */
	readonly db: DbClient;
	/** Full server plugin registry — capability declarations
	 * (jobs.kind/jobs.schedulable/events.topic) and the
	 * package-granular pluginEnabled probe read it. */
	readonly plugins: readonly Plugin[];
	/** Composition-built job-handler registry — the app edge registers
	 * its kinds (builtin + plugin-owned) before calling. */
	readonly jobHandlers: JobHandlerRegistry;
	/** `run`/`runAs` of the composed app runtime. */
	readonly run: ServerRuntime["run"];
	readonly runAs: ServerRuntime["runAs"];
	/** Generic job enqueuers on the shared transports — undefined when
	 * the corresponding queue binding is absent. */
	readonly jobs?: JobsEnqueuer;
	readonly themeJobs?: JobsEnqueuer;
	/** Deploy-resolved AI runner (undefined unbound) and the
	 * composition root's transcription model id. */
	readonly ai?: ServerRuntime["ai"];
	readonly audioTranscribeModel: string;
	/** Interop record exporters behind the @ktb/interop port. */
	readonly recordExporters?: ServerRuntime["recordExporters"];
	/** Active UI locale getter (the host's request-scoped locale). */
	readonly getLocale: () => string;
	/** Deploy-time cron jobs + fire routines. `cronRunners` is invoked
	 * once with the factory's scheduled-job dispatcher so the
	 * scheduler-heartbeat runner can sweep through the same path the
	 * console uses. */
	readonly cronJobs: readonly ServerRuntimeCronJob[];
	readonly cronRunners: (
		dispatchScheduledJob: ScheduledJobDispatch,
	) => Readonly<Record<string, () => Promise<CronRunOutcome>>>;
	/** Durable-orchestration start surface — undefined when the jobs
	 * transport is unbound (the app builds the host lazily inside its
	 * runtime). */
	readonly orchestration?: ServerRuntime["orchestration"];
	/** DB-canonical i18n capability — app-bound (it resolves the
	 * request scope chain through framework request headers and the
	 * i18n plugin), handed in ready-made. */
	readonly i18n?: ServerRuntime["i18n"];
	/** Auth provider request handler for the auth plugin's
	 * `/api/auth/*` catch-all. */
	readonly authHandler?: ServerRuntime["authHandler"];
	/** argv prefix for the `connect` command bridge links mint. */
	readonly aiBridgeCli?: string;
}

export interface ServerRuntimeBundle {
	/** The composed capability registry — hand to `setServerRuntime`. */
	readonly runtime: ServerRuntime;
	/** `scheduled()` entry point: fire every cron job bound to the
	 * controller's cron expression through the registry — same code
	 * path as the console's "run now", including the job_runs
	 * projection. Unknown expressions are a no-op. */
	readonly dispatchCronSchedule: (schedule: string) => Promise<readonly CronDispatchResult[]>;
}

export const makeServerRuntime = (deps: ServerRuntimeDeps): ServerRuntimeBundle => {
	const env = deps.env;
	const db = deps.db;

	// Ops probes: the queue depth signal exists only when the bound
	// queue exposes stats — the dev:node SQLite queue does; the
	// workerd Queue binding doesn't (prod queues are managed in the
	// Cloudflare dashboard, so the ops console reports them as
	// externally managed). The storage probe paginates the bucket's
	// list() with a page cap; a missing listing capability or a failed
	// page resolves null → the page shows "unavailable", never a fake
	// zero.
	const queueDepthProbe = (env.AUDIO_QUEUE as { stats?: () => Promise<QueueDepth> } | undefined)
		?.stats;
	const audioBucketLister = env.AUDIO_BUCKET as unknown as AudioObjectLister | undefined;

	// Queue registry for /platform/queue: every queue transport this
	// deployment binds. A stats() probe marks the dev:node SQLite
	// stand-in ("sqlite"); the workerd Queue binding has none ->
	// "cloudflare-queue" with null depth (managed in the Cloudflare
	// dashboard). dev:node additionally publishes REDIS_JOBS_QUEUE —
	// the ktb:jobs list apps/jobs-worker drains — as a
	// "redis"/"jobs-worker" entry. Unbound queues are omitted rather
	// than listed as fake rows.
	const boundQueueTransport = (binding: unknown): "cloudflare-queue" | "sqlite" =>
		(binding as { stats?: unknown } | undefined)?.stats === undefined
			? "cloudflare-queue"
			: "sqlite";
	const themeQueueStats = (
		env.THEME_ASSETS_QUEUE as { stats?: () => Promise<QueueDepth> } | undefined
	)?.stats;
	const redisJobsQueue = env.REDIS_JOBS_QUEUE as
		| { stats?: () => Promise<QueueDepth | null> }
		| undefined;
	const queueDescriptors: (QueueDescriptor | undefined)[] = [
		env.AUDIO_QUEUE === undefined
			? undefined
			: {
					id: "audio",
					name: "ktb-transcription",
					transport: boundQueueTransport(env.AUDIO_QUEUE),
					consumer: "in-app" as const,
					stats: queueDepthProbe,
				},
		env.THEME_ASSETS_QUEUE === undefined
			? undefined
			: {
					id: "theme-assets",
					name: "ktb-theme-assets",
					transport: boundQueueTransport(env.THEME_ASSETS_QUEUE),
					consumer: "in-app" as const,
					stats: themeQueueStats,
				},
		redisJobsQueue?.stats === undefined
			? undefined
			: {
					id: "jobs",
					name: env.JOBS_QUEUE?.toString() ?? "ktb:jobs",
					transport: "redis" as const,
					consumer: "jobs-worker" as const,
					stats: redisJobsQueue.stats,
				},
	];
	const queueRegistry = makeQueueRegistry(queueDescriptors.filter((d) => d !== undefined));

	// Pub/sub for /platform/pubsub: the in-process bus is always bound
	// (it is the zero-dependency default transport — one instance per
	// isolate); dev:node additionally publishes REDIS_PUBSUB, a lazy
	// Redis pub/sub transport whose PUBSUB CHANNELS/NUMSUB enumeration
	// surfaces real cross-process topics. Sources merge dynamically at
	// query time — topics appear when first published/subscribed,
	// never from a static list that could drift.
	const memoryPubSub = makeInProcessPubSub();
	const redisPubSub = env.REDIS_PUBSUB as
		| (PubSubBus & { listTopics?: PubSubTopicSource["list"] })
		| undefined;
	const pubsubSources: PubSubTopicSource[] = [
		{ id: "memory", list: async () => memoryPubSub.listTopics() },
		...(redisPubSub?.listTopics === undefined
			? []
			: [{ id: "redis", list: redisPubSub.listTopics }]),
	];
	const pubSubTopics = mergePubSubSources(pubsubSources);

	// P-094: plugin capability declarations — `jobs.kind` metadata,
	// `jobs.schedulable` schedule-ability, `events.topic` catalog.
	// Collected once at composition like the other definition
	// registries; invalid entries or duplicate ids fail boot loudly
	// (route-contribution contract). `jobs.schedulable.paramsSchema`
	// documents are compiled here too — a malformed schema fails boot
	// rather than every create.
	const jobKindDecls = collectJobKindDeclarations(deps.plugins);
	const schedulableDecls = collectSchedulableDeclarations(deps.plugins);
	const eventTopicDecls = collectEventTopicDeclarations(deps.plugins);
	const schedulableParamsValidators = compileSchedulableValidators(schedulableDecls);

	const jobs = deps.jobs;
	const jobHandlers = deps.jobHandlers;

	// Scheduler dispatch (P-094): a claimed scheduled_jobs row becomes
	// a job envelope on the shared transport — queue retry, payload
	// validation and the job_runs projection all come from jobs-port.
	// When no queue is bound (exotic dev setups), fall back to the
	// canonical inline kind-dispatch (@ktb/jobs-port dispatchJobInline —
	// same handler registry, decode and projection writes, minus queue
	// retry).
	const dispatchScheduledJob: ScheduledJobDispatch = async (job) => {
		const payload = job.params ?? {};
		if (jobs !== undefined) {
			await jobs.enqueue(job.kind, payload, { tenantId: job.tenantId });
			return;
		}
		await dispatchJobInline(
			{ handlers: jobHandlers.handlers(), db },
			{ kind: job.kind, payload, tenantId: job.tenantId },
		);
	};

	// scheduled_jobs row → console shape: drops the lease internals and
	// narrows `params` to the JSON-serializable view the server-fn
	// boundary requires.
	const toScheduleInfo = (job: ScheduledJob): ScheduledJobInfo => ({
		id: job.id,
		kind: job.kind,
		params: (job.params ?? null) as JsonValue | null,
		cronExpr: job.cronExpr,
		runAt: job.runAt,
		nextRunAt: job.nextRunAt,
		lastRunAt: job.lastRunAt,
		status: job.status,
		tenantId: job.tenantId,
		createdBy: job.createdBy,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
	});

	// Unified schedule entry → console shape: same JSON narrowing as
	// toScheduleInfo (params may be any decoded JSON; the wire type is
	// JsonValue).
	const toScheduleEntryInfo = (entry: ScheduleEntry): ScheduleEntryInfo => ({
		...entry,
		params: (entry.params ?? null) as JsonValue | null,
		lastRun:
			entry.lastRun === null
				? null
				: {
						ok: entry.lastRun.ok,
						running: entry.lastRun.running,
						error: entry.lastRun.error ?? null,
						at: entry.lastRun.at,
					},
	});

	// Cron registry: every scheduled job declared by the app gets a
	// fire routine here. Each fire is projected into job_runs under
	// kind `cron.<id>` (two-phase: processing → done/failed) so the
	// console reads lifecycle through the same transport-agnostic
	// projection as queues. Projection writes are best-effort — a
	// bookkeeping miss must never fail or retry the sweep itself, so
	// failures are logged and swallowed.
	const projectCronRun =
		(jobId: string, fire: () => Promise<CronRunOutcome>) => async (): Promise<CronRunOutcome> => {
			const id = crypto.randomUUID();
			const kind = `cron.${jobId}`;
			const write = (status: JobStatus, error?: string | null) =>
				upsertJobRun(db, { id, kind, status, error: error ?? null }).catch((e: unknown) => {
					console.error("cron projection write failed", { kind, status, error: String(e) });
				});
			await write("processing");
			// Real producer for the /platform/pubsub console: every cron
			// fire also lands on the in-process `cron.fires` topic, so
			// the page shows live traffic instead of an empty registry.
			// Fire-and-forget — a bus failure must never affect the
			// sweep.
			const announce = (outcome: CronRunOutcome) =>
				void memoryPubSub
					.publish("cron.fires", { jobId, ok: outcome.ok, summary: outcome.summary ?? null })
					.catch(
						/* v8 ignore next -- the in-process publish promise never rejects: listener failures are caught inside the bus */
						() => {},
					);
			try {
				const outcome = await fire();
				await write(outcome.ok ? "done" : "failed", outcome.error);
				announce(outcome);
				return outcome;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await write("failed", message);
				const outcome: CronRunOutcome = { ok: false, error: message };
				announce(outcome);
				return outcome;
			}
		};

	const cronRunners = deps.cronRunners(dispatchScheduledJob);
	const cronRegistry = makeCronRegistry(
		deps.cronJobs.map((meta): CronDescriptor => ({
			id: meta.id,
			schedules: meta.schedules,
			description: meta.description,
			run: projectCronRun(
				meta.id,
				cronRunners[meta.id] ?? (async () => ({ ok: false, error: "no runner registered" })),
			),
		})),
	);

	/** Latest `cron.<id>` projection row per registered job — one
	 * bounded prefix read, grouped client-side. Null rows mean "never
	 * ran or the projection is unreadable"; the console renders that
	 * honestly. */
	const cronLastRuns = async () => {
		const runs = await listJobRuns(db, { kindPrefix: "cron.", limit: 500 }).catch(() => null);
		const latest = new Map<string, JobRecord>();
		for (const run of runs ?? []) {
			if (!latest.has(run.kind)) latest.set(run.kind, run);
		}
		return latest;
	};

	// P-094: the SchedulerDo durable-object namespace — precision
	// backstop for one-off scheduled_jobs run_at times. The
	// * * * * * heartbeat sweeps at minute granularity; the DO's alarm
	// fires the same sweep at the exact instant. Absent binding (dev
	// without DO) degrades to heartbeat-only timing.
	const schedulerDoNs = env.SCHEDULER as unknown as SchedulerDoNamespace | undefined;

	/** Mirror a scheduled_jobs row's timing state into the DO: active
	 * one-offs arm an alarm at runAt; everything else clears the
	 * entry. Fire-and-forget safe — notifySchedulerDo swallows DO
	 * failures and the heartbeat backstops any missed notification. */
	const syncSchedulerDo = async (job: ScheduledJob | null, id: string): Promise<void> => {
		if (job !== null && job.status === "active" && job.runAt !== null) {
			await notifySchedulerDo(schedulerDoNs, "/schedule", { id, runAt: job.runAt });
		} else {
			await notifySchedulerDo(schedulerDoNs, "/unschedule", { id });
		}
	};

	// F3b: the AcpBridge durable-object namespace (workerd binding).
	// Structural slice only; the plugin route reaches it through
	// ServerRuntime.acpBridge, never the env.
	const acpBridgeNs = env.ACP_BRIDGE as unknown as
		| {
				readonly idFromName: (name: string) => unknown;
				readonly get: (id: unknown) => { fetch(request: Request): Promise<Response> };
		  }
		| undefined;

	const runtime: ServerRuntime = {
		run: deps.run,
		runAs: deps.runAs,
		audio: env.AUDIO_BUCKET as AudioStore | undefined,
		audioQueue: env.AUDIO_QUEUE as AudioQueueSender | undefined,
		themeAssets: env.THEME_ASSETS_BUCKET as unknown as AudioStore | undefined,
		// Media library (P-111): dedicated image bucket — same store
		// shape; the plugin's /api/images routes resolve rows through
		// Images and stream objects through this capability.
		images: env.IMAGES_BUCKET as unknown as AudioStore | undefined,
		themeJobs: deps.themeJobs,
		jobs,
		audioQueueDepth:
			typeof queueDepthProbe === "function" ? () => queueDepthProbe().catch(() => null) : undefined,
		audioStorageStats:
			audioBucketLister === undefined ? undefined : () => audioStorageStats(audioBucketLister),
		queues: () => queueRegistry.list(),
		// Cron registry capability: `list` joins each job with its
		// latest `cron.<id>` projection row; `runNow`/`runSchedule`
		// fire through the same projected path the worker's
		// `scheduled` handler uses.
		crons: {
			list: async () => {
				const latest = await cronLastRuns();
				return cronRegistry.list().map((job) => {
					const row = latest.get(`cron.${job.id}`);
					return {
						...job,
						lastRun:
							row === undefined
								? null
								: {
										id: row.id,
										ok: row.status === "done",
										running: row.status === "processing",
										error: row.error,
										startedAt: row.createdAt,
										finishedAt: row.updatedAt,
									},
					};
				});
			},
			runNow: async (id) => {
				const result = await cronRegistry.runById(id);
				return result === null
					? null
					: {
							id: result.id,
							ok: result.outcome.ok,
							summary: result.outcome.summary,
							error: result.outcome.error,
						};
			},
			runSchedule: async (schedule) =>
				(await cronRegistry.dispatch(schedule)).map((r) => ({
					id: r.id,
					ok: r.outcome.ok,
					summary: r.outcome.summary,
					error: r.outcome.error,
				})),
		},
		// Runtime scheduler capability (P-094): the scheduled_jobs
		// table behind /platform/cron's dynamic-schedules section.
		// Writes go through @ktb/scheduler-port validation; runNow
		// claims the row (schedule advances — no double-fire) and
		// dispatches through the same path the heartbeat sweep uses.
		schedules: {
			list: async () => (await listScheduledJobs(db)).map(toScheduleInfo),
			// Unified schedules read model: deploy-time cron registry jobs
			// (joined with their latest `cron.<id>` job_runs row) merged
			// with runtime scheduled_jobs rows — one list for the console.
			entries: async () => {
				const latest = await cronLastRuns();
				const runSlices = new Map(
					[...latest].map(([kind, run]) => [
						kind.slice("cron.".length),
						{
							ok: run.status === "done",
							running: run.status === "processing",
							error: run.error,
							at: run.createdAt,
						},
					]),
				);
				return listScheduleEntries({
					cronJobs: cronRegistry.list(),
					scheduledJobs: await listScheduledJobs(db),
					cronLastRuns: runSlices,
				}).map(toScheduleEntryInfo);
			},
			create: async (input) => {
				try {
					// Kind must be dispatchable: a registered handler
					// entry or a jobs.schedulable declaration (declared
					// kinds may ride transports with special
					// normalizers). Anything else can only ever fail at
					// fire time — reject early.
					if (!scheduleKindDispatchable(input.kind, jobHandlers.handlers(), schedulableDecls)) {
						throw new InvalidScheduleError(`unknown job kind: ${input.kind}`);
					}
					// Declared paramsSchemas gate schedule params: the
					// value must satisfy at least one schema declared
					// for the kind.
					const paramsError = scheduleParamsError(
						input.kind,
						input.params,
						schedulableParamsValidators,
					);
					if (paramsError !== null) {
						throw new InvalidScheduleError(paramsError);
					}
					const job = await insertScheduledJob(db, input);
					await syncSchedulerDo(job, job.id);
					return { ok: true as const, job: toScheduleInfo(job) };
				} catch (error) {
					return error instanceof InvalidScheduleError
						? { ok: false as const, reason: "invalid" as const, error: error.message }
						: { ok: false as const, reason: "unavailable" as const, error: String(error) };
				}
			},
			update: async (id, patch) => {
				try {
					const job = await updateScheduledJob(db, id, patch);
					if (job === null) {
						return { ok: false as const, reason: "not-found" as const };
					}
					await syncSchedulerDo(job, id);
					return { ok: true as const, job: toScheduleInfo(job) };
				} catch (error) {
					return error instanceof InvalidScheduleError
						? { ok: false as const, reason: "invalid" as const, error: error.message }
						: { ok: false as const, reason: "unavailable" as const, error: String(error) };
				}
			},
			remove: async (id) => {
				const removed = await deleteScheduledJob(db, id);
				if (removed) await syncSchedulerDo(null, id);
				return removed
					? { ok: true as const }
					: { ok: false as const, reason: "not-found" as const };
			},
			runNow: async (id) => {
				const result = await runScheduledJobNow(db, id, dispatchScheduledJob);
				// The claim already advanced the schedule — mirror the
				// new state so a fired one-off clears its DO alarm
				// entry.
				if (result !== null) await syncSchedulerDo(result.job, id);
				return result === null
					? null
					: {
							id: result.job.id,
							ok: result.error === null,
							summary: `fired ${result.job.kind}`,
							error: result.error ?? undefined,
						};
			},
		},
		jobKinds: () => jobHandlers.kinds(),
		// P-120 phase 2: durable orchestration start surface — plugin
		// fns (pipeline admin) reach runner.start through this
		// capability; the consumer side is the orchestrator.step
		// registration on the app's job-handler registry.
		orchestration: deps.orchestration,
		// P-094: capability-declaration views — handler registration
		// merged with jobs.kind/jobs.schedulable declarations, plus
		// the events.topic catalog for the pub/sub console.
		jobKindInfo: () => jobKindInfos(jobHandlers.handlers(), jobKindDecls, schedulableDecls),
		schedulableKinds: () => schedulableKindInfos(schedulableDecls),
		// Pub/sub capability: `topics` merges the in-process bus's
		// known topics with Redis PUBSUB CHANNELS (when dev:node bound
		// it); `publish` routes by the console-facing id prefix —
		// `memory:` to the in-process bus, `redis:` to the Redis
		// transport. Payloads must be JSON-serializable; transports
		// serialize them.
		pubsub: {
			topics: () => pubSubTopics.list(),
			publish: async (topicId, payload) => {
				const sep = topicId.indexOf(":");
				const prefix = sep === -1 ? "" : topicId.slice(0, sep);
				const name = sep === -1 ? topicId : topicId.slice(sep + 1);
				try {
					if (name === "") return { ok: false, reason: "unknown-topic" };
					if (prefix === "memory") {
						await memoryPubSub.publish(name, payload);
						return { ok: true };
					}
					if (prefix === "redis") {
						if (redisPubSub === undefined) return { ok: false, reason: "unavailable" };
						await redisPubSub.publish(name, payload);
						return { ok: true };
					}
					return { ok: false, reason: "unknown-topic" };
				} catch {
					return { ok: false, reason: "publish-failed" };
				}
			},
			declaredTopics: () => eventTopicInfos(eventTopicDecls),
		},
		ai: deps.ai,
		audioTranscribeModel: deps.audioTranscribeModel,
		recordExporters: deps.recordExporters,
		getLocale: deps.getLocale,
		i18n: deps.i18n,
		// P-058: backs `pluginEnabledFn` / `createPluginFileRoute` /
		// `createPluginApiRoute`. Package-granular like every other
		// enable-state surface: the route stays live while ANY plugin
		// of the owning package (`plugins/<pkg>`) is enabled —
		// disabling `patients.routes` alone no longer kills the
		// package's file routes while `patients.services` is still on.
		// Ids without a pkg stamp (out-of-glob plugins, unknown ids)
		// keep the per-id check.
		pluginEnabled: (pluginId) =>
			deps.run(
				Effect.gen(function* () {
					const states = yield* PluginStates;
					const plugin = deps.plugins.find((p) => p.id === pluginId);
					if (plugin?.pkg === undefined) return yield* states.isEnabled(pluginId);
					return packageLive(deps.plugins, yield* states.enabledIds(), plugin.pkg);
				}),
			),
		// P-062: the auth plugin's /api/auth/* catch-all reaches the
		// better-auth instance through this capability — plugins never
		// import the adapter.
		authHandler: deps.authHandler,
		// F3b: the bridge route's handoff to the AcpBridge durable
		// object (idFromName(endpointId)). The ?endpoint= rewrite lets
		// the DO stamp ai_endpoint.last_seen_at on connect/heartbeat.
		// Undefined when the binding is absent (Node dev).
		acpBridge:
			acpBridgeNs === undefined
				? undefined
				: (endpointId, request) => {
						const url = new URL(request.url);
						url.searchParams.set("endpoint", String(endpointId));
						return acpBridgeNs
							.get(acpBridgeNs.idFromName(String(endpointId)))
							.fetch(new Request(url, request));
					},
		aiBridgeCli: deps.aiBridgeCli,
	};

	return {
		runtime,
		dispatchCronSchedule: (schedule) => cronRegistry.dispatch(schedule),
	};
};
