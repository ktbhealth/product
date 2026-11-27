import type * as Effect from "effect/Effect";
import type { I18nShape, ScopeChain } from "@ktb/i18n";
import type { ExportFormat, RecordExporter } from "@ktb/interop";
import type { TenantSelector } from "@ktb/tenant/selector";

/** The slice of R2 needed to drop objects — the real R2Bucket satisfies this. */
export interface AudioDeleter {
	delete(keys: string[]): Promise<void>;
}

/** Stored object slice the audio routes stream back (R2ObjectBody-compatible). */
export interface AudioObject {
	readonly body: ReadableStream;
	readonly size: number;
	readonly httpMetadata?: { readonly contentType?: string } | null;
}

/** Metadata-only view (R2Object-compatible) — size without the body. */
interface AudioHead {
	readonly size: number;
	readonly httpMetadata?: { readonly contentType?: string } | null;
}

/** Byte-range get (R2Range-compatible): offset+length, or suffix = the
 * last N bytes. Lets the download route honor HTTP Range so browsers
 * treat stored audio as seekable media. */
interface AudioRange {
	readonly offset?: number;
	readonly length?: number;
	readonly suffix?: number;
}

/**
 * The slice of R2Bucket the consultation audio routes need: store on
 * upload, stream on download, delete on purge. The real R2Bucket
 * satisfies this; `audio` carries it so plugin routes never touch the
 * binding directly.
 */
export interface AudioStore extends AudioDeleter {
	head(key: string): Promise<AudioHead | null>;
	get(key: string, options?: { readonly range?: AudioRange }): Promise<AudioObject | null>;
	put(
		key: string,
		value: ArrayBuffer | Uint8Array | ReadableStream,
		options?: { readonly httpMetadata?: { readonly contentType?: string } },
	): Promise<unknown>;
}

/** Message enqueued for async transcription (P-016). `tenantId` is the
 * owning tenant (`groups.id`) or null/absent for personal scope — the
 * consumer re-binds tenant scope from it (P-053 phase D); messages
 * enqueued before tenancy carry no field and stay personal. */
export interface AudioJobMessage {
	readonly consultationId: number;
	readonly audioKey: string;
	readonly userId: string;
	readonly tenantId?: number | null;
}

/** The slice of the workerd Queue producer the upload route needs. */
export interface AudioQueueSender {
	send(message: AudioJobMessage): Promise<unknown>;
}

/** Options accepted by the generic jobs enqueue port (PL-007). */
export interface JobEnqueueOptions {
	/** Owning tenant (`groups.id`) or null/absent for personal scope —
	 * same convention as {@link AudioJobMessage.tenantId}. */
	readonly tenantId?: number | null;
	/** Optional pointer to where the payload lives (never PHI/blob inline). */
	readonly payloadRef?: string | null;
}

/**
 * Generic job enqueue capability (PL-007): plugins enqueue
 * `{kind, payload}` jobs without touching the queue binding — the host
 * adapter writes the `job_runs` projection and sends the envelope on the
 * shared transport. Structural mirror of `@ktb/jobs-port`'s
 * JobsEnqueuer; declared here so plugin code needs no new dependency.
 */
export interface JobsEnqueuer {
	enqueue(kind: string, payload: unknown, options?: JobEnqueueOptions): Promise<unknown>;
}

/**
 * Row-count snapshot of the transcription queue, grouped by delivery
 * status. Only available when the bound queue exposes stats — the
 * dev:node SQLite queue does; the workerd Queue binding does not
 * (production queues are managed in the Cloudflare dashboard, so the
 * ops console reports them as externally managed instead).
 */
export interface QueueDepth {
	readonly pending: number;
	readonly processing: number;
	readonly done: number;
	readonly failed: number;
}

/**
 * Aggregate object stats for the audio bucket. `truncated` means the
 * listing hit the page cap — counts are a lower bound, not exact.
 */
export interface AudioStorageStats {
	readonly objects: number;
	readonly bytes: number;
	readonly truncated: boolean;
}

/** Transport family a bound queue belongs to — structural mirror of
 * `QueueTransport` in @ktb/queues-port (declared here so plugin code
 * needs no new dependency). */
export type QueueTransport = "cloudflare-queue" | "redis" | "sqlite" | "unknown";

/** Who drains a bound queue — structural mirror of `QueueConsumer` in
 * @ktb/queues-port. */
export type QueueConsumer = "in-app" | "jobs-worker" | "external" | "none";

/**
 * One queue as the /platform/queue console sees it — identity plus
 * best-effort broker depth. `depth` is null when the transport cannot
 * report it (prod Cloudflare Queues have no query API); the page
 * renders the honest unavailable state, never a fabricated zero.
 * Structural mirror of `QueueInfo` in @ktb/queues-port.
 */
export interface QueueInfo {
	readonly id: string;
	readonly name: string;
	readonly transport: QueueTransport;
	readonly consumer: QueueConsumer;
	readonly depth: QueueDepth | null;
}

/** One recorded cron fire — projected into `job_runs` under kind
 * `cron.<jobId>`; this is the console-facing slice of that row.
 * `ok` derives from the row status (done = success); `startedAt` /
 * `finishedAt` are the row's created/updated epochs. */
export interface CronRunInfo {
	readonly id: string;
	readonly ok: boolean;
	/** True while the latest row is still `processing` — an isolate
	 * death mid-fire can leave one stuck; the console renders it
	 * neutrally rather than as a failure. */
	readonly running: boolean;
	readonly error?: string | null;
	readonly startedAt: number;
	readonly finishedAt: number;
}

/** One registered cron job as the /platform/cron console sees it. */
export interface CronJobInfo {
	readonly id: string;
	readonly schedules: readonly string[];
	readonly description?: string;
	/** Latest recorded fire; null when the job has never run (or the
	 * projection is unreadable — the page renders that honestly). */
	readonly lastRun: CronRunInfo | null;
}

/** Outcome of a manual "run now" — mirrors @ktb/cron-port's
 * CronRunOutcome plus the fired job id. */
export interface CronRunResult {
	readonly id: string;
	readonly ok: boolean;
	readonly summary?: string;
	readonly error?: string;
}

/** JSON-serializable payload — the shape `scheduled_jobs.params`
 * carries across the server-fn boundary (strict mode rejects
 * `unknown` in responses). */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/** Lifecycle of a runtime schedule row — structural mirror of
 * `ScheduledJobStatus` in @ktb/scheduler-port. */
export type ScheduledJobStatus = "active" | "paused" | "done";

/** One `scheduled_jobs` row as the /platform/cron console sees it —
 * structural mirror of `ScheduledJob` in @ktb/scheduler-port (params
 * arrives decoded). */
export interface ScheduledJobInfo {
	readonly id: string;
	readonly kind: string;
	readonly params: JsonValue | null;
	readonly cronExpr: string | null;
	readonly runAt: number | null;
	readonly nextRunAt: number;
	readonly lastRunAt: number | null;
	readonly status: ScheduledJobStatus;
	readonly tenantId: number | null;
	readonly createdBy: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Fields accepted when creating a schedule — exactly one of
 * `cronExpr`/`runAt` (validated server-side). */
export interface ScheduledJobCreateInput {
	readonly kind: string;
	readonly params?: unknown;
	readonly cronExpr?: string | null;
	readonly runAt?: number | null;
	readonly tenantId?: number | null;
	readonly createdBy?: string | null;
}

/** Mutable schedule fields — schedule changes recompute nextRunAt. */
export interface ScheduledJobUpdateInput {
	readonly params?: unknown;
	readonly cronExpr?: string | null;
	readonly runAt?: number | null;
	readonly status?: ScheduledJobStatus;
}

/** Honest write outcome — `invalid` carries the validation message. */
export type ScheduleWriteResult =
	| { readonly ok: true; readonly job: ScheduledJobInfo }
	| {
			readonly ok: false;
			readonly reason: "invalid" | "unavailable" | "not-found";
			readonly error?: string;
	  };

export type ScheduleDeleteResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "unavailable" | "not-found" };

/** One job kind as consoles see it: handler registration merged with
 * plugin `jobs.kind`/`jobs.schedulable` declarations (P-094).
 * `registered` is the live jobHandlers state — a declared-but-
 * unregistered kind is catalog data, not dispatchable. */
export interface JobKindInfo {
	readonly kind: string;
	readonly registered: boolean;
	readonly pluginId?: string;
	readonly description?: string;
	readonly concurrency?: number;
	readonly maxAttempts?: number;
	readonly idempotent?: boolean;
	/** True when at least one `jobs.schedulable` declaration targets
	 * this kind — the create-schedule picker admits it. */
	readonly schedulable: boolean;
}

/** One `jobs.schedulable` declaration as the schedule-creation UI sees
 * it — `kind` is the dispatchable job kind; `paramsSchema` is a JSON
 * Schema document (JsonValue-shaped) validated server-side on create. */
export interface SchedulableKindInfo {
	readonly id: string;
	readonly kind: string;
	readonly pluginId?: string;
	readonly description?: string;
	readonly paramsSchema?: JsonValue;
	readonly suggestedCronExpr?: string;
	readonly suggestedParams?: JsonValue | null;
}

/** One `events.topic` declaration — catalog metadata for a pub/sub
 * topic, independent of whether a transport currently enumerates it. */
export interface EventTopicInfo {
	readonly topic: string;
	readonly pluginId?: string;
	readonly description?: string;
	readonly payloadSchema?: JsonValue;
}

/** Transport family a pub/sub topic source belongs to — structural
 * mirror of `PubSubTransport` in @ktb/pubsub-port (declared here so
 * plugin code needs no new dependency). */
export type PubSubTransport = "in-process" | "redis" | "unknown";

/** One retained message on an introspectable topic. */
export interface PubSubMessageInfo {
	readonly at: number;
	readonly payload: unknown;
}

/**
 * One pub/sub topic as the /platform/pubsub console sees it — identity
 * plus best-effort subscriber count and (when the transport retains
 * history) recent payloads. `subscribers` is null and `recent`
 * undefined when the transport cannot report them; the page renders
 * the honest unavailable state, never a fabricated zero.
 * Structural mirror of `PubSubTopicInfo` in @ktb/pubsub-port.
 */
export interface PubSubTopicInfo {
	readonly id: string;
	readonly name: string;
	readonly transport: PubSubTransport;
	readonly subscribers: number | null;
	readonly recent?: readonly PubSubMessageInfo[];
}

/** Outcome of a manual publish — honest failure reasons, never a
 * thrown wire error for expected cases. */
export interface PubSubPublishResult {
	readonly ok: boolean;
	readonly reason?: "forbidden" | "unknown-topic" | "unavailable" | "publish-failed";
}

/** One merged topic enumeration: surviving topics plus the ids of
 * sources whose probe failed — a bound-but-down transport is reported
 * honestly instead of silently vanishing into an empty list.
 * Structural mirror of `PubSubTopicListing` in @ktb/pubsub-port. */
export interface PubSubTopicsResult {
	readonly topics: readonly PubSubTopicInfo[];
	readonly degraded: readonly string[];
}

/**
 * Minimal paginated listing slice — the real R2Bucket satisfies this
 * (its `list` returns R2Objects, a superset of the shape below). Used
 * only by the ops stats probe; audio routes never list.
 */
export interface AudioObjectLister {
	list(options?: { readonly limit?: number; readonly cursor?: string }): Promise<{
		readonly objects: readonly { readonly key: string; readonly size: number }[];
		readonly truncated: boolean;
		readonly cursor?: string;
	}>;
}

/** Page cap for the storage stats probe — an ops health signal needs
 * an order-of-magnitude count, not a full bucket inventory. */
const STORAGE_STATS_MAX_PAGES = 5;

/**
 * Aggregate object count + bytes over an R2-style lister, capped at
 * `maxPages` pages. Returns null when the bucket cannot list or any
 * page fails — the ops console renders "unavailable", never a fake
 * zero.
 */
export const audioStorageStats = async (
	bucket: AudioObjectLister | undefined,
	maxPages = STORAGE_STATS_MAX_PAGES,
): Promise<AudioStorageStats | null> => {
	if (bucket?.list === undefined) return null;
	try {
		let objects = 0;
		let bytes = 0;
		let cursor: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const result = await bucket.list({ limit: 1000, cursor });
			for (const object of result.objects) {
				objects += 1;
				bytes += object.size;
			}
			if (!result.truncated) return { objects, bytes, truncated: false };
			cursor = result.cursor;
			// Truncated without a cursor cannot be paged further.
			if (cursor === undefined) return { objects, bytes, truncated: true };
		}
		return { objects, bytes, truncated: true };
	} catch {
		return null;
	}
};

/** The slice of the Workers AI binding the transcribe route needs. */
export interface AiRunner {
	run(model: string, inputs: unknown): Promise<unknown>;
}

/**
 * Host capabilities plugin server functions may reach. Populated once by
 * the composition root (apps/web `lib/platform.ts`) — plugins never read
 * env or platform bindings themselves; the env read stays host-side
 * behind this registry (P-033).
 */
export interface ServerRuntime {
	/** Run an Effect program against the composed app runtime (system paths). */
	readonly run: <A, E>(effect: Effect.Effect<A, E, unknown>) => Promise<A>;
	/** Run an Effect program as an authenticated user (Principal +
	 * resolved Tenant bound). `tenantSelector` is the opaque request
	 * selector forwarded to the app's TenantResolver — omit for the
	 * resolver's default path. `user.actorId` marks delegated access:
	 * pass the `ActingUser` from `getDoctorUser`/`ensureDoctorUser`. */
	readonly runAs: <A, E>(
		user: { readonly id: string; readonly email?: string; readonly actorId?: string },
		effect: Effect.Effect<A, E, unknown>,
		tenantSelector?: TenantSelector | null,
	) => Promise<A>;
	/** Audio object storage for upload/download routes and best-effort
	 * purge; undefined when unbound. */
	readonly audio?: AudioStore;
	/** Queue producer for async transcription jobs; undefined when unbound. */
	readonly audioQueue?: AudioQueueSender;
	/** Theme asset object storage (R2) for brand images/fonts — the
	 * same store shape as `audio`; undefined when unbound (P-082). */
	readonly themeAssets?: AudioStore;
	/** Media-library object storage (R2) for site images (P-111) — the
	 * same store shape as `audio`; undefined when unbound. */
	readonly images?: AudioStore;
	/** Generic job enqueue port bound to the DEDICATED theme-assets
	 * queue (PL-006 phase 4 — decided over sharing the transcription
	 * transport). Undefined when unbound. */
	readonly themeJobs?: JobsEnqueuer;
	/** Generic job enqueue port (PL-007) — kind-dispatched jobs on the
	 * same queue transport as audioQueue. Undefined when unbound. */
	readonly jobs?: JobsEnqueuer;
	/** Queue depth probe — present only when the bound queue exposes
	 * stats (the dev:node SQLite queue). Resolves null on probe failure;
	 * undefined field means the queue is managed externally. */
	readonly audioQueueDepth?: () => Promise<QueueDepth | null>;
	/** Audio bucket aggregate stats (object count + bytes, capped
	 * pagination); undefined when no bucket binding is published. */
	readonly audioStorageStats?: () => Promise<AudioStorageStats | null>;
	/** Queue registry probe (PL-007 follow-up): every transport the
	 * deployment binds, with best-effort depth. Undefined outside the
	 * composed app; an empty list means no queues are bound. */
	readonly queues?: () => Promise<readonly QueueInfo[]>;
	/** Cron registry capability (PL-007 follow-up): the scheduled-job
	 * registry the worker's `scheduled` handler dispatches through.
	 * `list` joins each job with its latest `cron.<id>` job_runs row;
	 * `runNow` fires one job by id (console trigger — same code path
	 * as a cron fire, including projection); `runSchedule` fires every
	 * job bound to a cron expression (the `scheduled()` entry). */
	readonly crons?: {
		readonly list: () => Promise<readonly CronJobInfo[]>;
		readonly runNow: (id: string) => Promise<CronRunResult | null>;
		readonly runSchedule: (schedule: string) => Promise<readonly CronRunResult[]>;
	};
	/** Runtime scheduler capability (P-094): the `scheduled_jobs`
	 * table behind /platform/cron's dynamic-schedules section. `list`
	 * reads every row; `create`/`update` validate the schedule fields
	 * server-side; `runNow` claims and dispatches one row immediately
	 * (the schedule still advances — no double-fire). Undefined outside
	 * the composed app. */
	readonly schedules?: {
		readonly list: () => Promise<readonly ScheduledJobInfo[]>;
		readonly create: (input: ScheduledJobCreateInput) => Promise<ScheduleWriteResult>;
		readonly update: (id: string, patch: ScheduledJobUpdateInput) => Promise<ScheduleWriteResult>;
		readonly remove: (id: string) => Promise<ScheduleDeleteResult>;
		readonly runNow: (id: string) => Promise<CronRunResult | null>;
	};
	/** Registered job kinds the scheduler can dispatch — the kind
	 * picker's source of truth (jobHandlers registry keys). Undefined
	 * outside the composed app. */
	readonly jobKinds?: () => readonly string[];
	/** Durable orchestration runner (P-120 phase 2): `startRun`
	 * persists a run for `defId` and enqueues its first
	 * `orchestrator.step` job through the shared queue transport.
	 * Undefined when the jobs transport is unbound — orchestration
	 * cannot be driven without it. `tenantId` stamps
	 * `orchestration_runs.tenant_id` (and the step envelope's tenant);
	 * callers resolve it from the bound `Tenant` — omit/null for
	 * platform/personal scope. Reads stay admin-cross-tenant (the
	 * PlatformAdmin gate is the boundary), so this remains a system
	 * path, not a tenant-scoped service. */
	readonly orchestration?: {
		readonly startRun: (
			defId: string,
			input?: unknown,
			tenantId?: number | null,
		) => Promise<string>;
	};
	/** Enriched job-kind view: registered handler state merged with
	 * `jobs.kind`/`jobs.schedulable` plugin declarations (P-094).
	 * Undefined outside the composed app. */
	readonly jobKindInfo?: () => readonly JobKindInfo[];
	/** `jobs.schedulable` declarations — the kind picker for schedule
	 * creation, with params schemas and suggested defaults. Undefined
	 * outside the composed app. */
	readonly schedulableKinds?: () => readonly SchedulableKindInfo[];
	/** Pub/sub capability: `topics` merges every bound transport's
	 * channel enumeration (in-process bus + Redis channels); `publish`
	 * routes a JSON payload to a topic by its console-facing id —
	 * `memory:<name>` hits the in-process bus, `redis:<channel>` the
	 * Redis transport. Undefined when no pub/sub transport is bound. */
	readonly pubsub?: {
		readonly topics: () => Promise<PubSubTopicsResult>;
		readonly publish: (topicId: string, payload: unknown) => Promise<PubSubPublishResult>;
		/** `events.topic` plugin declarations — the topic catalog,
		 * distinct from live transport enumeration. */
		readonly declaredTopics?: () => readonly EventTopicInfo[];
	};
	/** Workers AI binding (or host-resolved stand-in) for transcription;
	 * undefined when unbound. */
	readonly ai?: AiRunner;
	/** Model id for audio transcription jobs/routes; resolved by the
	 * composition root from deploy config — the port never names a
	 * provider model itself. */
	readonly audioTranscribeModel: string;
	/** Speaker diarization on the transcription job (P-118): when the
	 * host's ASR backend exposes a diarization endpoint, the consumer
	 * labels each transcript segment. Absent/false = unspeaker'd. */
	readonly audioDiarization?: boolean;
	/** Dedicated runner for the diarization backend (P-118): ASR and
	 * diarization often live on different endpoints (e.g. a proven
	 * Whisper image keeps VAD segmentation while a newer Speaches
	 * serves `/audio/diarization`). Absent = diarize on `ai`. */
	readonly audioDiarizationAi?: AiRunner;
	/** Interop record exporters behind the @ktb/interop port — the host
	 * wires the standard-specific adapters, plugins only see the port. */
	readonly recordExporters?: Record<ExportFormat, RecordExporter>;
	/** Active UI locale — the host's request-scoped UI locale (locale-context ALS). */
	readonly getLocale: () => string;
	/**
	 * DB-canonical i18n (P-083/PL-008): resolves the request's scope chain
	 * + locale chain into a bound `I18n` shape over the isolate catalog
	 * cache. `locale` defaults to the active UI locale; `scopeChain`
	 * defaults to global scope until tenant/portal wiring lands. Absent
	 * outside the composed app or before the i18n plugin registers.
	 */
	readonly i18n?: (input?: {
		readonly locale?: string;
		readonly scopeChain?: ScopeChain;
	}) => Promise<I18nShape>;
	/**
	 * Plugin enable-state check (P-058) backing `pluginEnabledFn` and the
	 * `createPluginFileRoute`/`createPluginApiRoute` gates. The
	 * composition root wires it PACKAGE-granular (live while any member
	 * plugin id of the owning `plugins/<pkg>` is enabled); absent
	 * (tests, non-app contexts) the gate is inert — there is no
	 * plugin_state store to consult anyway.
	 */
	readonly pluginEnabled?: (pluginId: string) => Promise<boolean>;
	/**
	 * Credential-provider request handler for the auth plugin's
	 * `/api/auth/*` catch-all (P-062): the composition root owns the
	 * provider instance (apps/web deliberately builds it outside the
	 * driver registry — see @ktb/app-host), so plugin routes reach it
	 * through this capability instead of importing the adapter. Absent
	 * outside the composed app — the route answers 500.
	 */
	readonly authHandler?: (request: Request) => Promise<Response>;
	/**
	 * AcpBridge durable-object handoff (F3b): forwards a validated
	 * WebSocket upgrade request for `endpointId` to the DO holding the
	 * bridge's socket (`idFromName(endpointId)`). The composition root
	 * owns the `ACP_BRIDGE` binding; the plugin route never touches
	 * it. Undefined when unbound (Node dev) — the route answers 501.
	 */
	readonly acpBridge?: (endpointId: number, request: Request) => Promise<Response>;
	/**
	 * F3b: argv prefix for the `connect` command `createBridgeLinkFn`
	 * mints — e.g. `bun /abs/repo/packages/ai-bridge/src/cli.ts` in dev
	 * (the package is unpublished, so `bunx` would 404) or
	 * `bunx @ktb/ai-bridge` once it ships. The composition root resolves
	 * it; absent → the fn emits the published-package invocation.
	 */
	readonly aiBridgeCli?: string;
}

let runtime: ServerRuntime | undefined;

/** Composition-root hook: call once at startup before any server fn runs. */
export const setServerRuntime = (next: ServerRuntime): void => {
	runtime = next;
};

/** Test hook: drop the registry between cases. */
export const resetServerRuntime = (): void => {
	runtime = undefined;
};

export const getServerRuntime = (): ServerRuntime => {
	if (runtime === undefined)
		throw new Error(
			"@ktb/server-fns: runtime not initialized — call setServerRuntime() at the composition root",
		);
	return runtime;
};

/**
 * Non-throwing variant of `getServerRuntime` for optional capabilities
 * (the plugin route gate): `undefined` outside the composed app, where
 * callers degrade to their documented default instead of crashing.
 */
export const peekServerRuntime = (): ServerRuntime | undefined => runtime;

/** `run` against the registered runtime. */
export const run = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
	getServerRuntime().run(effect);

/** `runAs` against the registered runtime. */
export const runAs = <A, E>(
	user: { readonly id: string; readonly email?: string; readonly actorId?: string },
	effect: Effect.Effect<A, E, unknown>,
	tenantSelector?: TenantSelector | null,
): Promise<A> => getServerRuntime().runAs(user, effect, tenantSelector);

/** Active locale for the current request (SSR ALS / client cookie). */
export const getLocale = (): string => getServerRuntime().getLocale();

/** Bound i18n shape for the current request (PL-008). Throws when the
 * composition root did not wire the capability (tests, bare runtimes). */
export const getI18n = (input?: {
	readonly locale?: string;
	readonly scopeChain?: ScopeChain;
}): Promise<I18nShape> => {
	const capability = getServerRuntime().i18n;
	if (capability === undefined) {
		throw new Error("@ktb/server-fns: i18n capability not wired — setServerRuntime() lacks `i18n`");
	}
	return capability(input);
};

/** R2 delete batch size — the bucket accepts at most 1000 keys per call. */
const AUDIO_DELETE_BATCH = 1000;

/**
 * Best-effort removal of consultation audio once its database rows are
 * gone (storage is outside the D1 batch). Returns the keys that could
 * not be removed so the caller can report orphaned recordings instead
 * of losing track of patient audio silently.
 */
export const purgeAudio = async (
	bucket: AudioDeleter | undefined,
	keys: readonly string[],
): Promise<string[]> => {
	// Stryker disable next-line ConditionalExpression: with keys empty every path returns an empty array — the loop is skipped and !bucket returns [...keys] = [] (verified equivalent over undefined/bound bucket × empty/non-empty keys)
	if (keys.length === 0) return [];
	if (!bucket) return [...keys];
	const failed: string[] = [];
	for (let i = 0; i < keys.length; i += AUDIO_DELETE_BATCH) {
		const batch = keys.slice(i, i + AUDIO_DELETE_BATCH);
		try {
			await bucket.delete(batch);
		} catch (error) {
			console.error("audio purge failed", { keys: batch.length, error });
			failed.push(...batch);
		}
	}
	return failed;
};
