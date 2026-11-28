import { env } from "cloudflare:workers";
import { connect as socketConnect } from "cloudflare:sockets";
import { fileURLToPath } from "node:url";

import { getSessionAccount, getTenantSelector, setServerRuntime } from "@ktb/server-fns";
import type { TenantSelector } from "@ktb/tenant/selector";
import {
	makeTenantResolver,
	TenantResolver,
	tenantSelectorFromHeaders,
	tenantScopeId,
} from "@ktb/tenant";
import { Db, makeDb, type SqlDatabase } from "@ktb/db";
import * as Effect from "effect/Effect";
import { makeJobHandlerRegistry, makeJobs, queueSend, type QueueSendBinding } from "@ktb/jobs-port";
import { asQueueTransport, type QueueBindingLike } from "@ktb/queues-port";
import { drainOutbox } from "@ktb/outbox";
import { runSchedulerSweep } from "@ktb/scheduler-port";
import { APP_CRON_JOBS } from "./cron-jobs.ts";
import { AUDIO_QUEUE_NAME, THEME_ASSETS_QUEUE_NAME } from "./queue-names.ts";
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
import { registerOutboxDeliverers } from "./outbox.ts";
import { EVAL_RUN_JOB_KIND, evalRunJobRegistration } from "@ktb/eval-validator/run-job";
import { portalInstances } from "./registry.ts";
import { builtinMiddlewareStages } from "./middleware-stages.ts";
import { makeTenantDirectory } from "./tenant-directory.ts";
import {
	makeFlushThrottler,
	requestTelemetryContext,
	setAccessLogSink,
} from "@ktb/observability-edge";
import { createApp, makeServerRuntime } from "@ktb/app-host";
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

/** Interop adapters behind the @ktb/interop port, one per supported standard. */
const recordExporters: Record<ExportFormat, RecordExporter> = {
	"fhir-r4": fhirR4Exporter,
	openehr: openEhrExporter,
};

// Queue transports (QueueTransport port, @ktb/queues-port): every bound
// endpoint adapts structurally — `send` always, `stats` only when the
// binding carries a probe (T-035 ops probes). The same adapted
// transports feed the jobs enqueuers here and the /platform/queue
// registry inside makeServerRuntime.
const audioQueue =
	env.AUDIO_QUEUE === undefined
		? undefined
		: asQueueTransport(env.AUDIO_QUEUE as QueueBindingLike, { name: AUDIO_QUEUE_NAME });

// PL-007: the generic jobs port rides the same AUDIO_QUEUE transport —
// enqueue writes the job_runs projection (via `db`) then sends the
// kind-dispatched envelope. Undefined when the queue is unbound; the
// consumer side lives in @ktb/consultations/audio-consumer (kind →
// handler dispatch over jobHandlerRegistry below, wired by
// lib/audio-jobs.ts).
// The jobs enqueuer binds the RAW queue binding through `queueSend`,
// not `audioQueue.send`: asQueueTransport's send drops the options
// argument, so envelope `runAt` (delayed orchestrator.step deliveries)
// would be silently ignored. `audioQueue` still feeds the
// /platform/queue registry via makeServerRuntime below.
const jobsQueue = env.AUDIO_QUEUE as unknown as QueueSendBinding | undefined;
const jobs = jobsQueue === undefined ? undefined : makeJobs({ send: queueSend(jobsQueue), db });

// Composition-built kind → handler registry for this process's queue
// consumers (PL-007). Every kind the web consumer dispatches is
// registered here at module init — builtin kinds plus plugin-owned
// kinds wired through their edge modules (eval.run below; the audio
// consumer merges its own registration in lib/audio-jobs.ts). Exported
// for that wiring and for tests that recompose this module.
export const jobHandlerRegistry = makeJobHandlerRegistry();

// The /platform/queue console's smoke kind. Registered
// unconditionally — a no-op handler is harmless when AUDIO_QUEUE is
// unbound.
jobHandlerRegistry.register("jobs.ping", { handle: async () => {} });

// eval.run — the eval-validator plugin's consumer. Plugin manifests
// stay data-only (contribution meta is serializable), so the handler
// value is wired here at the edge, same pattern as the audio consumer.
jobHandlerRegistry.register(EVAL_RUN_JOB_KIND, evalRunJobRegistration());

// Outbox drainer (@ktb/outbox): the "email" kind deliverer resolves the
// configured Email sender per delivery — see lib/outbox.ts. Enqueue
// paths (auth hooks, plugin invites) also kick a best-effort drain;
// this registry + the outbox-drain cron sweep are the durable side.
registerOutboxDeliverers(run);

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
orchestration?.registerStepHandler(jobHandlerRegistry);

// PL-006 phase 4: theme asset uploads ride a DEDICATED queue
// (THEME_ASSETS_QUEUE_NAME) — image derivatives and font downloads
// never contend with transcription. Same jobs-port shape: job_runs
// projection + kind-dispatched envelope; the consumer lives in
// @ktb/theme/jobs. Same raw-binding rule as `jobs` above: `queueSend`
// carries `runAt` through `delaySeconds`.
const themeQueue =
	env.THEME_ASSETS_QUEUE === undefined
		? undefined
		: asQueueTransport(env.THEME_ASSETS_QUEUE as QueueBindingLike, {
				name: THEME_ASSETS_QUEUE_NAME,
			});
const themeJobsQueue = env.THEME_ASSETS_QUEUE as unknown as QueueSendBinding | undefined;
const themeJobs =
	themeJobsQueue === undefined ? undefined : makeJobs({ send: queueSend(themeJobsQueue), db });

// The generic console-capability block (queue/cron/schedule/pubsub
// registries, job-kind declarations, scheduled-job dispatch, the
// plugin-state probe) lives in @ktb/app-host's makeServerRuntime —
// this file keeps only app-bound wiring (env reads, cron fire
// routines, i18n scope resolution, AI/auth/bridge capabilities).

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
// without importing this module. The generic console-capability block
// (queues, crons, schedules, job kinds, pub/sub, plugin-state) is
// composed by @ktb/app-host's makeServerRuntime; this file hands it
// the app-bound pieces — env bindings, the job-handler registry, cron
// fire routines, orchestration host, i18n scope resolution, AI/auth.
const serverRuntime = makeServerRuntime({
	env: appEnv,
	db,
	plugins: serverPlugins,
	jobHandlers: jobHandlerRegistry,
	run,
	runAs,
	jobs,
	themeJobs,
	queueTransports: { audio: audioQueue, themeAssets: themeQueue },
	ai: aiBinding,
	audioTranscribeModel,
	recordExporters,
	getLocale: currentLocale,
	cronJobs: APP_CRON_JOBS,
	cronRunners: (dispatchScheduledJob) => ({
		"scheduler-heartbeat": async () => {
			const result = await runSchedulerSweep(db, dispatchScheduledJob);
			return {
				ok: result.failed === 0,
				summary: `${result.fired} scheduled job${result.fired === 1 ? "" : "s"} fired${result.failed > 0 ? `, ${result.failed} failed` : ""}`,
				...(result.failed > 0 ? { error: `${result.failed} dispatch(es) failed` } : {}),
			};
		},
		"outbox-drain": async () => {
			const result = await drainOutbox(db);
			return {
				ok: result.failed === 0,
				summary: `${result.delivered} outbox item${result.delivered === 1 ? "" : "s"} delivered${result.failed > 0 ? `, ${result.failed} failed` : ""}`,
				...(result.failed > 0 ? { error: `${result.failed} deliverie(s) failed` } : {}),
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
	}),
	// P-120 phase 2: the orchestration host is app-bound (it builds the
	// runner lazily inside `run`); only its start surface crosses into
	// the runtime capability.
	orchestration:
		orchestration === undefined
			? undefined
			: {
					startRun: (defId, input, tenantId) =>
						orchestration.startRun(defId, input, undefined, tenantId),
				},
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
	// P-062: the auth plugin's /api/auth/* catch-all reaches the
	// better-auth instance through this capability — plugins never
	// import the adapter.
	authHandler: (request) => auth.handler(request),
	aiBridgeCli,
});
setServerRuntime(serverRuntime.runtime);

/**
 * `scheduled()` entry point (src/server.ts): fire every cron job bound
 * to the controller's cron expression through the registry — same code
 * path as the console's "run now", including the job_runs projection.
 * Unknown expressions are a no-op.
 */
export const runScheduledCron = serverRuntime.dispatchCronSchedule;

// Raw platform binding passthrough — not composed, just exposed.
export const ai = aiBinding;
export const audioBucket = env.AUDIO_BUCKET;
export const themeAssetsBucket = env.THEME_ASSETS_BUCKET;
export const imagesBucket = env.IMAGES_BUCKET;

/** Coalesced flush (see @ktb/observability-edge): at most one real drain per
 * min-interval across ALL callers — the worker entry invokes this after
 * every fetch and queue batch, and per-request draining would multiply
 * OTLP export subrequests under load. */
const throttledFlush = makeFlushThrottler();

/** Drain OTLP exporters after request/batch handling — bounded and
 * never rejects; the worker entry schedules it via `ctx.waitUntil`. */
export const flushTelemetry = (): Promise<void> => throttledFlush(app.flushTelemetry);
