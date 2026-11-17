import { env } from "cloudflare:workers";
import { connect as socketConnect } from "cloudflare:sockets";

import {
	audioStorageStats,
	getSessionAccount,
	getTenantSelector,
	setServerRuntime,
	type AudioObjectLister,
	type AudioStore,
	type QueueDepth,
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
import { makeJobs } from "@ktb/jobs-port";
import { currentLocale } from "./locale-context.ts";
import { GLOBAL_SCOPE, resolveRequestLocales, tenantScope } from "@ktb/i18n";
import {
	catalogSlice,
	DEFAULT_LOCALE,
	I18nRuntime,
	listEnabledLocales,
	resolveRequestI18n,
} from "@ktb/i18n-plugin";

import { resolveAi, type AiEnv } from "./ai.ts";
import { emailCatalogT, verificationEmail } from "./emails.ts";
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

// Verification email resolves its copy from the DB `app` namespace at
// send time (PL-008): request locale → enabled-locale chain → catalog
// slice. `run` is defined below — the callback only fires per send,
// long after module init. A resolution failure falls back to the
// English literals inside verificationEmail (email must not break
// sign-up).
const app = createApp(appEnv as unknown as typeof env, {
	tenantResolver,
	verificationEmail: async ({ name, url }) => {
		const t = await run(
			Effect.gen(function* () {
				const database = yield* Db;
				const enabled = yield* Effect.promise(() => listEnabledLocales(database));
				const chain = resolveRequestLocales(currentLocale(), enabled, DEFAULT_LOCALE);
				const catalog = yield* catalogSlice(database, {
					namespaces: ["app"],
					scopeChain: GLOBAL_SCOPE,
					locales: chain,
				});
				return emailCatalogT(catalog, chain.locales[0] ?? DEFAULT_LOCALE);
			}),
		).catch(() => undefined);
		return verificationEmail({ name, url }, t);
	},
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
// consumer side lives in audio-jobs.ts (kind → handler registry).
const jobsQueue = env.AUDIO_QUEUE as unknown as
	| { send(body: unknown): Promise<unknown> }
	| undefined;
const jobs =
	jobsQueue === undefined
		? undefined
		: makeJobs({ send: (envelope) => jobsQueue.send(envelope), db });

// PL-006 phase 4: theme asset uploads ride a DEDICATED queue
// (ktb-theme-assets) — image derivatives and font downloads never
// contend with transcription. Same jobs-port shape: job_runs projection
// + kind-dispatched envelope; the consumer lives in theme-jobs.ts.
const themeJobsQueue = env.THEME_ASSETS_QUEUE as unknown as
	| { send(body: unknown): Promise<unknown> }
	| undefined;
const themeJobs =
	themeJobsQueue === undefined
		? undefined
		: makeJobs({ send: (envelope) => themeJobsQueue.send(envelope), db });

/**
 * Request scope chain for the i18n capability (PL-008): the same
 * pipeline `i18nRouteFn` uses — tenant headers + session account →
 * TenantResolver → tenantScope; anonymous/selector-less requests stay
 * global. Portal scope is NOT derivable here: plugin server fns run on
 * the RPC endpoint, not the page path, so callers needing portal-scoped
 * copy pass `scopeChain` explicitly (same escape hatch as before).
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

// F3b: the AcpBridge durable-object namespace (workerd binding —
// declared in the Alchemy stack). Structural slice only; the plugin
// route reaches it through ServerRuntime.acpBridge, never the env.
const acpBridgeNs = env.ACP_BRIDGE as unknown as
	| {
			readonly idFromName: (name: string) => unknown;
			readonly get: (id: unknown) => { fetch(request: Request): Promise<Response> };
	  }
	| undefined;

// P-033: publish the runtime to @ktb/server-fns so plugin-owned server
// functions (plugins/*/src/**) reach run/runAs, audio purge and locale
// without importing this module. Env reads stay here — the registry
// only hands out already-resolved capabilities.
setServerRuntime({
	run,
	runAs,
	audio: env.AUDIO_BUCKET,
	audioQueue: env.AUDIO_QUEUE,
	themeAssets: env.THEME_ASSETS_BUCKET as unknown as AudioStore | undefined,
	themeJobs,
	jobs,
	audioQueueDepth:
		typeof queueDepthProbe === "function" ? () => queueDepthProbe().catch(() => null) : undefined,
	audioStorageStats:
		audioBucketLister === undefined ? undefined : () => audioStorageStats(audioBucketLister),
	ai: aiBinding,
	audioTranscribeModel,
	recordExporters,
	getLocale: currentLocale,
	// PL-008: DB-canonical i18n capability — resolves enabled locales +
	// scope chain inside the app runtime (I18nRuntime cache + Db) and
	// returns the request-bound I18n shape. Locale defaults to the
	// request-scoped UI locale (locale-context ALS); scope defaults to
	// the request's tenant chain (portal scope stays caller-supplied —
	// see requestScopeChain).
	i18n: (input) =>
		run(
			Effect.gen(function* () {
				const runtime = yield* I18nRuntime;
				const database = yield* Db;
				const scopeChain = input?.scopeChain ?? (yield* requestScopeChain());
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
});

// Raw platform binding passthrough — not composed, just exposed.
export const ai = aiBinding;
export const audioBucket = env.AUDIO_BUCKET;
export const themeAssetsBucket = env.THEME_ASSETS_BUCKET;

/** Coalesced flush (see telemetry-flush.ts): at most one real drain per
 * min-interval across ALL callers — the worker entry invokes this after
 * every fetch and queue batch, and per-request draining would multiply
 * OTLP export subrequests under load. */
const throttledFlush = makeFlushThrottler();

/** Drain OTLP exporters after request/batch handling — bounded and
 * never rejects; the worker entry schedules it via `ctx.waitUntil`. */
export const flushTelemetry = (): Promise<void> => throttledFlush(app.flushTelemetry);
