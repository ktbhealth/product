import { env } from "cloudflare:workers";
import { connect as socketConnect } from "cloudflare:sockets";
import { fileURLToPath } from "node:url";

import {
	audioStorageStats,
	getSessionAccount,
	getTenantSelector,
	setServerRuntime,
	type AudioObjectLister,
	type AudioStore,
	type JsonValue,
	type QueueDepth,
	type ScheduledJobInfo,
} from "@ktb/server-fns";
import type { TenantSelector } from "@ktb/tenant/selector";
import {
	makeTenantResolver,
	TenantResolver,
	tenantSelectorFromHeaders,
	tenantScopeId,
} from "@ktb/tenant";
import { Db, makeDb, type SqlDatabase } from "@ktb/db";
import * as Effect from "effect/Effect";
import { PluginStates } from "@ktb/platform/plugin-states";
import {
	collectEventTopicDeclarations,
	collectJobKindDeclarations,
	collectSchedulableDeclarations,
} from "@ktb/platform/capabilities";
import {
	compileSchedulableValidators,
	eventTopicInfos,
	jobKindInfos,
	scheduleKindDispatchable,
	scheduleParamsError,
	schedulableKindInfos,
} from "./platform-capabilities.ts";
import {
	jobHandlers,
	makeJobs,
	registerJobHandler,
	upsertJobRun,
	listJobRuns,
} from "@ktb/jobs-port";
import type { JobRecord, JobStatus } from "@ktb/jobs-port";
import { makeCronRegistry, type CronDescriptor, type CronRunOutcome } from "@ktb/cron-port";
import {
	deleteScheduledJob,
	insertScheduledJob,
	InvalidScheduleError,
	listScheduledJobs,
	runScheduledJobNow,
	runSchedulerSweep,
	updateScheduledJob,
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
import { APP_CRON_JOBS } from "./cron-jobs.ts";
import { runScheduledAgendaReminders } from "./agenda-reminders.ts";
import { runScheduledAuditVerification } from "./audit-chain.ts";
import { currentLocale } from "./locale-context.ts";
import {
	GLOBAL_SCOPE,
	PSEUDO_LOCALE,
	resolveRequestLocales,
	tenantScope,
	type ScopeChain,
} from "@ktb/i18n";
import {
	catalogSlice,
	DEFAULT_LOCALE,
	I18nRuntime,
	listEnabledLocales,
	resolveRequestI18n,
} from "@ktb/i18n-plugin";

import { resolveAi, type AiEnv } from "./ai.ts";
import { resolveAiBridgeCli } from "./ai-bridge-cli.ts";
import { emailCatalogT, passwordResetEmail, verificationEmail } from "./emails.ts";
import { makeOrchestrationHost } from "./orchestration.ts";
import { portalInstances } from "./registry.ts";
import { builtinMiddlewareStages } from "./middleware-stages.ts";
import { makeTenantDirectory } from "./tenant-directory.ts";
import { requestTelemetryContext } from "./telemetry.ts";
import { makeFlushThrottler } from "./telemetry-flush.ts";
import { setAccessLogSink } from "./access-log.ts";
import { createApp } from "@ktb/app-host";
import { packageLive } from "@ktb/kernel";
import type { ExportFormat, RecordExporter } from "@ktb/interop";
import { fhirR4Exporter } from "@ktb/interop-fhir";
import { openEhrExporter } from "@ktb/interop-openehr";

// Deploy-target glue: the only place cloudflare:workers env is read.
// All composition (plugin registry, layers, runtime) lives in @ktb/app-host.
// Secrets/config reach the worker as bindings only — dev via .dev.vars
// (scripts/dev-secrets.mjs), prod via the Alchemy stack (alchemy.run.ts).
// No process.env reads: the worker stays portable across runtimes.

// AI_STUB > AI_BASE_URL > env.AI — dev may run without the Workers AI
// binding (wrangler.dev.jsonc), so resolve before composing the app.
const aiBinding = resolveAi(env as unknown as AiEnv);

const appEnv = { ...env, AI: aiBinding, SMTP_CONNECT: socketConnect } as Record<string, unknown>;

// Tenant resolution (P-053, phase A): the directory reads the groups
// plugin's membership tables directly (edge adapter — the groups
// service is PlatformAdmin-gated); resolution runs per request inside
// runAs. Fallback stays "personal" so requests without a tenant
// selector keep the pre-tenancy ownerId-scoped behavior. With no
// selector, a user with exactly one membership auto-selects it; zero
// or several memberships fall through to personal scope.
const tenantResolver = makeTenantResolver({
	directory: makeTenantDirectory(makeDb(env.DB as unknown as SqlDatabase)),
	fallback: "personal",
	selectDefault: (memberships) => (memberships.length === 1 ? memberships[0] : undefined),
});

// Transactional email resolves its copy from the DB `app` namespace at
// send time (PL-008): request locale → enabled-locale chain → catalog
// slice. `run` is defined below — the callback only fires per send,
// long after module init. A resolution failure falls back to the
// English literals inside the email composers (email must not break
// the auth flow it serves).
const resolveEmailCatalogT = () =>
	run(
		Effect.gen(function* () {
			const database = yield* Db;
			const enabled = yield* Effect.promise(() => listEnabledLocales(database));
			// `qps` is a QA pseudo-locale — outbound email must never
			// ship accented/bracketed copy, so it resolves against the
			// default locale instead of the request locale.
			const requested = currentLocale();
			const chain = resolveRequestLocales(
				requested === PSEUDO_LOCALE ? DEFAULT_LOCALE : requested,
				enabled,
				DEFAULT_LOCALE,
			);
			const catalog = yield* catalogSlice(database, {
				namespaces: ["app"],
				scopeChain: GLOBAL_SCOPE,
				locales: chain,
			});
			return emailCatalogT(catalog, chain.locales[0] ?? DEFAULT_LOCALE);
		}),
	).catch(() => undefined);

const app = createApp(appEnv as unknown as typeof env, {
	tenantResolver,
	// PL-015: the page-dispatch middleware chain — the admin view
	// (MiddlewareStages service) lists these alongside plugin stages.
	middleware: builtinMiddlewareStages,
	verificationEmail: async ({ name, url }) =>
		verificationEmail({ name, url }, await resolveEmailCatalogT()),
	passwordResetEmail: async ({ name, url }) =>
		passwordResetEmail({ name, url }, await resolveEmailCatalogT()),
});

// T-105: hand the request middleware (start.ts — outside the Effect
// runtime, and client-safe so it can't import this module) a way to
// emit `http.access` through the configured logger set, OTLP included.
setAccessLogSink(app.logAccess);

export const {
	BindingLive,
	correctTranscript,
	db,
	auth,
	// Full server registry (tables/services/panel page loaders) — the
	// counterpart of the client-safe `plugins` in #/plugins.ts. Server
	// fns that dispatch `panel.pages` handlers read this; it must never
	// be imported by client-reachable module scope.
	plugins: serverPlugins,
} = app;

/**
 * `run`/`runAs` with telemetry seeding: every invocation gets a
 * request-scoped `TelemetryContext` (request id + inbound traceparent
 * from the HTTP request, or a fresh id outside one) so logs, spans and
 * metrics correlate end-to-end. `runAs` additionally binds user/tenant
 * inside app-host.
 */
export const run = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
	requestTelemetryContext().then((telemetry) => app.run(effect, telemetry));

/**
 * `runAs` with tenant-selector extraction (P-053): when the caller does
 * not pass a selector, the request's tenant headers
 * (`x-tenant-id`/`x-tenant-slug`/`x-tenant-kind`/`x-tenant`) are read and
 * forwarded to the app's TenantResolver, which binds `Tenant` inside
 * the per-request effect scope. An explicit `null` selector skips
 * extraction; extraction failures outside a request context (tests,
 * non-HTTP invocations) degrade to `null` — ambient tenant is never
 * inherited into background work.
 */
export const runAs = <A, E>(
	user: { readonly id: string; readonly email?: string; readonly actorId?: string },
	effect: Effect.Effect<A, E, unknown>,
	tenantSelector?: TenantSelector | null,
): Promise<A> => {
	if (tenantSelector !== undefined) {
		return requestTelemetryContext().then((telemetry) =>
			app.runAs(user, effect, tenantSelector, telemetry),
		);
	}
	return (async () => {
		let selector: TenantSelector | null = null;
		try {
			selector = await getTenantSelector();
		} catch {
			// No request context — personal scope.
		}
		const telemetry = await requestTelemetryContext();
		return app.runAs(user, effect, selector, telemetry);
	})();
};

/** Fallback transcription model when AUDIO_TRANSCRIBE_MODEL is unset —
 * deploy glue owns provider defaults; ports carry no provider literals. */
const DEFAULT_AUDIO_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Model id for the server-side audio transcription job — bound per
 * deploy (Workers AI model on Cloudflare, ignored by OpenAI-compatible
 * stand-ins). Defaults to the recommended Workers AI Whisper model. */
export const audioTranscribeModel =
	appEnv.AUDIO_TRANSCRIBE_MODEL?.toString() ?? DEFAULT_AUDIO_MODEL;

/** Speaker diarization on the audio pipeline (P-118): opt-in flag —
 * only meaningful when AI_BASE_URL points at a backend exposing
 * `/v1/audio/diarization` (Speaches >= 0.9). Off by default: Workers
 * AI has no such endpoint and a wasted call per job is cost. */
export const audioDiarization = appEnv.AUDIO_DIARIZATION?.toString() === "1";

/** Interop adapters behind the @ktb/interop port, one per supported standard. */
const recordExporters: Record<ExportFormat, RecordExporter> = {
	"fhir-r4": fhirR4Exporter,
	openehr: openEhrExporter,
};

// Ops probes (T-035): the queue depth signal exists only when the bound
// queue exposes stats — the dev:node SQLite queue does; the workerd
// Queue binding doesn't (prod queues are managed in the Cloudflare
// dashboard, so the ops console reports them as externally managed).
// The storage probe paginates the bucket's list() with a page cap; a
// missing listing capability or a failed page resolves null → the page
// shows "unavailable", never a fake zero.
const queueDepthProbe = (env.AUDIO_QUEUE as { stats?: () => Promise<QueueDepth> } | undefined)
	?.stats;
const audioBucketLister = env.AUDIO_BUCKET as unknown as AudioObjectLister | undefined;

// PL-007: the generic jobs port rides the same AUDIO_QUEUE transport —
// enqueue writes the job_runs projection (via `db`) then sends the
// kind-dispatched envelope. Undefined when the queue is unbound; the
// consumer side lives in @ktb/consultations/audio-consumer (kind →
// handler registry in @ktb/jobs-port, wired by lib/audio-jobs.ts).
const jobsQueue = env.AUDIO_QUEUE as unknown as
	| { send(body: unknown): Promise<unknown> }
	| undefined;
const jobs =
	jobsQueue === undefined
		? undefined
		: makeJobs({ send: (envelope) => jobsQueue.send(envelope), db });

// The /platform/queue console's smoke kind: jobs-worker registers
// jobs.ping for the Redis transport; the web consumer needs its own
// registration or console enqueues would land as "unknown job kind".
// Registered unconditionally — the registry is per-process and a
// no-op handler is harmless when AUDIO_QUEUE is unbound.
registerJobHandler("jobs.ping", { handle: async () => {} });

// Durable orchestration runner (P-120 phase 2): `orchestrator.step`
// rides the same AUDIO_QUEUE transport — start() persists the run and
// enqueues step 1; each step job advances one bounded batch and
// re-enqueues the next (or marks the run terminal). The runner builds
// lazily inside the app runtime on first use — see
// lib/orchestration.ts for the ambientContext/loadStoredDefs wiring.
// Unbound queue → no registration AND no start capability: nothing
// can produce or consume step jobs, and "unknown job kind" is the
// honest signal for a stray message.
const orchestration = jobs === undefined ? undefined : makeOrchestrationHost({ run, db, jobs });
orchestration?.registerStepHandler();

// PL-006 phase 4: theme asset uploads ride a DEDICATED queue
// (ktb-theme-assets) — image derivatives and font downloads never
// contend with transcription. Same jobs-port shape: job_runs projection
// + kind-dispatched envelope; the consumer lives in @ktb/theme/jobs.
const themeJobsQueue = env.THEME_ASSETS_QUEUE as unknown as
	| { send(body: unknown): Promise<unknown> }
	| undefined;
const themeJobs =
	themeJobsQueue === undefined
		? undefined
		: makeJobs({ send: (envelope) => themeJobsQueue.send(envelope), db });

// Queue registry for /platform/queue (PL-007 follow-up): every queue
// transport this deployment binds. A stats() probe marks the dev:node
// SQLite stand-in ("sqlite"); the workerd Queue binding has none ->
// "cloudflare-queue" with null depth (managed in the Cloudflare
// dashboard). dev:node additionally publishes REDIS_JOBS_QUEUE — the
// ktb:jobs list apps/jobs-worker drains — as a "redis"/"jobs-worker"
// entry. Unbound queues are omitted rather than listed as fake rows.
const envRecord = env as unknown as Record<string, unknown>;
const boundQueueTransport = (binding: unknown): "cloudflare-queue" | "sqlite" =>
	(binding as { stats?: unknown } | undefined)?.stats === undefined ? "cloudflare-queue" : "sqlite";
const themeQueueStats = (
	env.THEME_ASSETS_QUEUE as { stats?: () => Promise<QueueDepth> } | undefined
)?.stats;
const redisJobsQueue = envRecord.REDIS_JOBS_QUEUE as
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
				name: envRecord.JOBS_QUEUE?.toString() ?? "ktb:jobs",
				transport: "redis" as const,
				consumer: "jobs-worker" as const,
				stats: redisJobsQueue.stats,
			},
];
const queueRegistry = makeQueueRegistry(queueDescriptors.filter((d) => d !== undefined));

// Pub/sub for /platform/pubsub: the in-process bus is always bound (it
// is the zero-dependency default transport — one instance per isolate);
// dev:node additionally publishes REDIS_PUBSUB, a lazy Redis pub/sub
// transport whose PUBSUB CHANNELS/NUMSUB enumeration surfaces real
// cross-process topics. Sources merge dynamically at query time —
// topics appear when first published/subscribed, never from a static
// list that could drift. Plugin code reaches publish/list through the
// `pubsub` ServerRuntime capability below; adapters stay at this edge.
const memoryPubSub = makeInProcessPubSub();
const redisPubSub = envRecord.REDIS_PUBSUB as
	| (PubSubBus & { listTopics?: PubSubTopicSource["list"] })
	| undefined;
const pubsubSources: PubSubTopicSource[] = [
	{ id: "memory", list: async () => memoryPubSub.listTopics() },
	...(redisPubSub?.listTopics === undefined ? [] : [{ id: "redis", list: redisPubSub.listTopics }]),
];
const pubSubTopics = mergePubSubSources(pubsubSources);

// Cron registry for /platform/cron + the worker's `scheduled` handler:
// every scheduled job declared in lib/cron-jobs.ts gets a fire routine
// here. Each fire is projected into job_runs under kind `cron.<id>`
// (two-phase: processing → done/failed) so the console reads lifecycle
// through the same transport-agnostic projection as queues. Projection
// writes are best-effort — a bookkeeping miss must never fail or retry
// the sweep itself, so failures are logged and swallowed.
const projectCronRun =
	(jobId: string, fire: () => Promise<CronRunOutcome>) => async (): Promise<CronRunOutcome> => {
		const id = crypto.randomUUID();
		const kind = `cron.${jobId}`;
		const write = (status: JobStatus, error?: string | null) =>
			upsertJobRun(db, { id, kind, status, error: error ?? null }).catch((e: unknown) => {
				console.error("cron projection write failed", { kind, status, error: String(e) });
			});
		await write("processing");
		// Real producer for the /platform/pubsub console: every cron fire
		// also lands on the in-process `cron.fires` topic, so the page
		// shows live traffic instead of an empty registry. Fire-and-
		// forget — a bus failure must never affect the sweep.
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

// P-094: plugin capability declarations — `jobs.kind` metadata,
// `jobs.schedulable` schedule-ability, `events.topic` catalog. Collected
// once at composition like the other definition registries; invalid
// entries or duplicate ids fail boot loudly (route-contribution
// contract). `jobs.schedulable.paramsSchema` documents are compiled
// here too — a malformed schema fails boot rather than every create.
const jobKindDecls = collectJobKindDeclarations(serverPlugins);
const schedulableDecls = collectSchedulableDeclarations(serverPlugins);
const eventTopicDecls = collectEventTopicDeclarations(serverPlugins);
const schedulableParamsValidators = compileSchedulableValidators(schedulableDecls);

// Scheduler dispatch (P-094): a claimed scheduled_jobs row becomes a
// job envelope on the shared transport — queue retry, payload
// validation and the job_runs projection all come from jobs-port.
// When no queue is bound (exotic dev setups), fall back to inline
// kind-dispatch through the same handler registry with the same
// projection writes, minus queue retry.
const dispatchScheduledJob: ScheduledJobDispatch = async (job) => {
	const payload = job.params ?? {};
	if (jobs !== undefined) {
		await jobs.enqueue(job.kind, payload, { tenantId: job.tenantId });
		return;
	}
	const registration = jobHandlers[job.kind];
	if (registration === undefined) throw new Error(`unknown job kind: ${job.kind}`);
	const id = crypto.randomUUID();
	const mark = (status: "processing" | "done" | "failed", error?: string) =>
		upsertJobRun(db, {
			id,
			kind: job.kind,
			status,
			error: error ?? null,
			tenantId: job.tenantId,
		}).catch((e: unknown) => {
			console.error("scheduler projection write failed", {
				kind: job.kind,
				status,
				error: String(e),
			});
		});
	await mark("processing");
	try {
		const decoded =
			registration.decodePayload === undefined ? payload : registration.decodePayload(payload);
		await registration.handle(decoded, {
			id,
			kind: job.kind,
			payload: decoded,
			tenantId: job.tenantId,
		});
		await mark("done");
	} catch (error) {
		await mark("failed", error instanceof Error ? error.message : String(error));
		throw error;
	}
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

const cronRunners: Record<string, () => Promise<CronRunOutcome>> = {
	"scheduler-heartbeat": async () => {
		const result = await runSchedulerSweep(db, dispatchScheduledJob);
		return {
			ok: result.failed === 0,
			summary: `${result.fired} scheduled job${result.fired === 1 ? "" : "s"} fired${result.failed > 0 ? `, ${result.failed} failed` : ""}`,
			...(result.failed > 0 ? { error: `${result.failed} dispatch(es) failed` } : {}),
		};
	},
	"agenda-reminders": async () => {
		const count = await runScheduledAgendaReminders();
		return count === null
			? { ok: false, error: "reminder sweep failed" }
			: { ok: true, summary: `${count} reminder${count === 1 ? "" : "s"} dispatched` };
	},
	"audit-chain-verify": async () => {
		const result = await runScheduledAuditVerification();
		if (result === null) return { ok: false, error: "audit chain verification failed" };
		return {
			ok: true,
			summary:
				result.status === "tampered"
					? `chain tampered at entry ${result.brokenAt}`
					: `chain verified (${result.entries} entries)`,
		};
	},
};

const cronRegistry = makeCronRegistry(
	APP_CRON_JOBS.map((meta): CronDescriptor => ({
		id: meta.id,
		schedules: meta.schedules,
		description: meta.description,
		run: projectCronRun(
			meta.id,
			cronRunners[meta.id] ?? (async () => ({ ok: false, error: "no runner registered" })),
		),
	})),
);

/**
 * `scheduled()` entry point (src/server.ts): fire every cron job bound
 * to the controller's cron expression through the registry — same code
 * path as the console's "run now", including the job_runs projection.
 * Unknown expressions are a no-op.
 */
export const runScheduledCron = (schedule: string) => cronRegistry.dispatch(schedule);

/** Latest `cron.<id>` projection row per registered job — one bounded
 * prefix read, grouped client-side. Null rows mean "never ran or the
 * projection is unreadable"; the console renders that honestly. */
const cronLastRuns = async () => {
	const runs = await listJobRuns(db, { kindPrefix: "cron.", limit: 500 }).catch(() => null);
	const latest = new Map<string, JobRecord>();
	for (const run of runs ?? []) {
		if (!latest.has(run.kind)) latest.set(run.kind, run);
	}
	return latest;
};

/**
 * Request scope chain for the i18n capability (PL-008): the same
 * pipeline `i18nRouteFn` uses — tenant headers + session account →
 * TenantResolver → tenantScope; anonymous/selector-less requests stay
 * global. Portal scope is NOT derivable here: plugin server fns run on
 * the RPC endpoint, not the page path, so callers needing portal-scoped
 * copy pass `scopeChain` explicitly — sanitized by sanitizeScopeChain
 * before use.
 */
const requestScopeChain = () =>
	Effect.gen(function* () {
		const headers = yield* Effect.promise(() =>
			import("@tanstack/react-start/server")
				.then((m) => m.getRequestHeaders())
				.catch(() => new Headers()),
		);
		const selector = tenantSelectorFromHeaders(headers);
		// No tenant headers → personal scope; skip the session lookup so
		// anonymous/app requests pay nothing extra.
		if (selector === null) return GLOBAL_SCOPE;
		const account = yield* Effect.promise(() => getSessionAccount(headers).catch(() => null));
		const resolver = yield* TenantResolver;
		const tenant = yield* resolver
			.resolve(selector, account?.id ?? null)
			.pipe(Effect.catch(() => Effect.succeed(null)));
		const tenantId = tenant === null ? null : tenantScopeId(tenant);
		return tenantId === null ? GLOBAL_SCOPE : tenantScope(String(tenantId));
	});

/** Portal instance ids the plugin registry declares — the only portal
 * scopes a caller-supplied chain may name (see sanitizeScopeChain). */
const KNOWN_PORTAL_SCOPE_IDS: ReadonlySet<string> = new Set(
	portalInstances.map((entry) => entry.instance.id),
);

/**
 * Caller-supplied scope chains are an escape hatch for portal-scoped
 * copy: plugin server fns run on the RPC endpoint, not the page path,
 * so the portal instance is not derivable from the request here. The
 * chain is NOT trusted verbatim — an entry survives only when provable:
 * `global` always; `tenant` only when its id matches the tenant the
 * request itself resolves to; `portal` only for ids the plugin
 * registry actually declares. Anything else is dropped, and the global
 * fallback is re-appended when nothing survives, so a caller cannot
 * read another tenant's scoped rows by naming them.
 */
const sanitizeScopeChain = (chain: ScopeChain, request: ScopeChain): ScopeChain => {
	const requestTenantIds = new Set(
		request.scopes.filter((s) => s.scope === "tenant").map((s) => s.scopeId),
	);
	const scopes = chain.scopes.flatMap((s) => {
		if (s.scope === "global") return [{ scope: "global" as const, scopeId: "" }];
		if (s.scope === "tenant" && requestTenantIds.has(s.scopeId)) return [s];
		if (s.scope === "portal" && KNOWN_PORTAL_SCOPE_IDS.has(s.scopeId)) return [s];
		return [];
	});
	if (!scopes.some((s) => s.scope === "global")) {
		scopes.push({ scope: "global", scopeId: "" });
	}
	return { scopes };
};

// F3b: the AcpBridge durable-object namespace (workerd binding —
// declared in the Alchemy stack). Structural slice only; the plugin
// route reaches it through ServerRuntime.acpBridge, never the env.
const acpBridgeNs = env.ACP_BRIDGE as unknown as
	| {
			readonly idFromName: (name: string) => unknown;
			readonly get: (id: unknown) => { fetch(request: Request): Promise<Response> };
	  }
	| undefined;

// P-094: the SchedulerDo durable-object namespace — precision backstop
// for one-off scheduled_jobs run_at times. The * * * * * heartbeat
// sweeps at minute granularity; the DO's alarm fires the same sweep at
// the exact instant. Absent binding (dev without DO) degrades to
// heartbeat-only timing.
const schedulerDoNs = env.SCHEDULER as unknown as SchedulerDoNamespace | undefined;

/** Mirror a scheduled_jobs row's timing state into the DO: active
 * one-offs arm an alarm at runAt; everything else clears the entry.
 * Fire-and-forget safe — notifySchedulerDo swallows DO failures and
 * the heartbeat backstops any missed notification. */
const syncSchedulerDo = async (job: ScheduledJob | null, id: string): Promise<void> => {
	if (job !== null && job.status === "active" && job.runAt !== null) {
		await notifySchedulerDo(schedulerDoNs, "/schedule", { id, runAt: job.runAt });
	} else {
		await notifySchedulerDo(schedulerDoNs, "/unschedule", { id });
	}
};

// F3b: argv prefix for the `connect` command createBridgeLinkFn mints
// (see lib/ai-bridge-cli.ts — unpublished package, dev resolves the
// repo source, prod the published bunx path). import.meta.env is a
// Vite-pipeline-only property; the cast keeps a possibly-absent shape.
// import.meta.url is a file:// URL under vite dev/workerd, but the
// vitest module-runner serves modules over http:// — fileURLToPath
// throws there, so fall back to a repo-relative path (the minted
// string is a suggestion; tests never execute it).
const repoCliPath = (() => {
	try {
		return fileURLToPath(new URL("../../../../packages/ai-bridge/src/cli.ts", import.meta.url));
	} catch {
		return "packages/ai-bridge/src/cli.ts";
	}
})();
const aiBridgeCli = resolveAiBridgeCli({
	override: env.AI_BRIDGE_CLI,
	dev: (import.meta as { env?: { DEV?: unknown } }).env?.DEV === true,
	cliPath: repoCliPath,
});

// P-033: publish the runtime to @ktb/server-fns so plugin-owned server
// functions (plugins/*/src/**) reach run/runAs, audio purge and locale
// without importing this module. Env reads stay here — the registry
// only hands out already-resolved capabilities.
setServerRuntime({
	run,
	runAs,
	audio: env.AUDIO_BUCKET as unknown as AudioStore | undefined,
	audioQueue: env.AUDIO_QUEUE,
	themeAssets: env.THEME_ASSETS_BUCKET as unknown as AudioStore | undefined,
	// Media library (P-111): dedicated image bucket — same store shape;
	// the plugin's /api/images routes resolve rows through Images and
	// stream objects through this capability.
	images: env.IMAGES_BUCKET as unknown as AudioStore | undefined,
	themeJobs,
	jobs,
	audioQueueDepth:
		typeof queueDepthProbe === "function" ? () => queueDepthProbe().catch(() => null) : undefined,
	audioStorageStats:
		audioBucketLister === undefined ? undefined : () => audioStorageStats(audioBucketLister),
	queues: () => queueRegistry.list(),
	// Cron registry capability: `list` joins each job with its latest
	// `cron.<id>` projection row; `runNow`/`runSchedule` fire through
	// the same projected path the worker's `scheduled` handler uses.
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
	// Runtime scheduler capability (P-094): the scheduled_jobs table
	// behind /platform/cron's dynamic-schedules section. Writes go
	// through @ktb/scheduler-port validation; runNow claims the row
	// (schedule advances — no double-fire) and dispatches through the
	// same path the heartbeat sweep uses.
	schedules: {
		list: async () => (await listScheduledJobs(db)).map(toScheduleInfo),
		create: async (input) => {
			try {
				// Kind must be dispatchable: a registered jobHandlers
				// entry or a jobs.schedulable declaration (declared kinds
				// may ride transports with special normalizers). Anything
				// else can only ever fail at fire time — reject early.
				if (!scheduleKindDispatchable(input.kind, jobHandlers, schedulableDecls)) {
					throw new InvalidScheduleError(`unknown job kind: ${input.kind}`);
				}
				// Declared paramsSchemas gate schedule params: the value
				// must satisfy at least one schema declared for the kind.
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
			return removed ? { ok: true as const } : { ok: false as const, reason: "not-found" as const };
		},
		runNow: async (id) => {
			const result = await runScheduledJobNow(db, id, dispatchScheduledJob);
			// The claim already advanced the schedule — mirror the new
			// state so a fired one-off clears its DO alarm entry.
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
	jobKinds: () => Object.keys(jobHandlers),
	// P-120 phase 2: durable orchestration start surface — plugin fns
	// (pipeline admin) reach runner.start through this capability; the
	// consumer side is the orchestrator.step registration above.
	orchestration:
		orchestration === undefined
			? undefined
			: {
					startRun: (defId, input, tenantId) =>
						orchestration.startRun(defId, input, undefined, tenantId),
				},
	// P-094: capability-declaration views — handler registration merged
	// with jobs.kind/jobs.schedulable declarations, plus the
	// events.topic catalog for the pub/sub console.
	jobKindInfo: () => jobKindInfos(jobHandlers, jobKindDecls, schedulableDecls),
	schedulableKinds: () => schedulableKindInfos(schedulableDecls),
	// Pub/sub capability: `topics` merges the in-process bus's known
	// topics with Redis PUBSUB CHANNELS (when dev:node bound it);
	// `publish` routes by the console-facing id prefix — `memory:` to
	// the in-process bus, `redis:` to the Redis transport. Payloads
	// must be JSON-serializable; transports serialize them.
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
	ai: aiBinding,
	audioTranscribeModel,
	audioDiarization,
	recordExporters,
	getLocale: currentLocale,
	// PL-008: DB-canonical i18n capability — resolves enabled locales +
	// scope chain inside the app runtime (I18nRuntime cache + Db) and
	// returns the request-bound I18n shape. Locale defaults to the
	// request-scoped UI locale (locale-context ALS); scope defaults to
	// the request's tenant chain. Portal scope stays caller-supplied
	// (see requestScopeChain) but is sanitized against the request
	// context — see sanitizeScopeChain.
	i18n: (input) =>
		run(
			Effect.gen(function* () {
				const runtime = yield* I18nRuntime;
				const database = yield* Db;
				// The request chain is always resolved: it is both the
				// fallback and the provenance check for caller-supplied
				// scopes.
				const requestChain = yield* requestScopeChain();
				const scopeChain =
					input?.scopeChain === undefined
						? requestChain
						: sanitizeScopeChain(input.scopeChain, requestChain);
				const { i18n } = yield* resolveRequestI18n(runtime, database, {
					requestedLocale: input?.locale ?? currentLocale(),
					scopeChain,
				});
				return i18n;
			}),
		),
	// P-058: backs `pluginEnabledFn` / `createPluginFileRoute` /
	// `createPluginApiRoute`. Package-granular like every other
	// enable-state surface: the route stays live while ANY plugin of the
	// owning package (`plugins/<pkg>`) is enabled — disabling
	// `patients.routes` alone no longer kills the package's file routes
	// while `patients.services` is still on. Ids without a pkg stamp
	// (out-of-glob plugins, unknown ids) keep the per-id check.
	pluginEnabled: (pluginId) =>
		run(
			Effect.gen(function* () {
				const states = yield* PluginStates;
				const plugin = serverPlugins.find((p) => p.id === pluginId);
				if (plugin?.pkg === undefined) return yield* states.isEnabled(pluginId);
				return packageLive(serverPlugins, yield* states.enabledIds(), plugin.pkg);
			}),
		),
	// P-062: the auth plugin's /api/auth/* catch-all reaches the
	// better-auth instance through this capability — plugins never
	// import the adapter.
	authHandler: (request) => auth.handler(request),
	// F3b: the bridge route's handoff to the AcpBridge durable object
	// (idFromName(endpointId)). The ?endpoint= rewrite lets the DO
	// stamp ai_endpoint.last_seen_at on connect/heartbeat. Undefined
	// when the binding is absent (Node dev).
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
	aiBridgeCli,
});

// Raw platform binding passthrough — not composed, just exposed.
export const ai = aiBinding;
export const audioBucket = env.AUDIO_BUCKET;
export const themeAssetsBucket = env.THEME_ASSETS_BUCKET;
export const imagesBucket = env.IMAGES_BUCKET;

/** Coalesced flush (see telemetry-flush.ts): at most one real drain per
 * min-interval across ALL callers — the worker entry invokes this after
 * every fetch and queue batch, and per-request draining would multiply
 * OTLP export subrequests under load. */
const throttledFlush = makeFlushThrottler();

/** Drain OTLP exporters after request/batch handling — bounded and
 * never rejects; the worker entry schedules it via `ctx.waitUntil`. */
export const flushTelemetry = (): Promise<void> => throttledFlush(app.flushTelemetry);
