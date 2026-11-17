import {
	discoverPlugins,
	enabledDrivers,
	orderPlugins,
	requireDriver,
	type Driver,
} from "@ktb/driver-framework";
import {
	appInvocationDuration,
	appInvocations,
	cqrsDispatchDuration,
	cqrsDispatches,
	cqrsDispatchFailures,
	externalSpanFromLogFields,
	externalSpanFromTraceparent,
	newRequestId,
	record,
	tagged,
	Telemetry,
	TelemetryContext,
	telemetryAnnotations,
	type ObservabilityEnv,
	type TelemetryContextValue,
} from "@ktb/observability";
import { otlpTelemetryDriver } from "@ktb/observability-otlp";
import { telemetryConsoleDriver } from "@ktb/observability";
import type { Plugin } from "@ktb/kernel";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	plugins as platformPlugins,
} from "@ktb/platform";
import { makePluginStatesLive, PluginDisabled, PluginStates } from "@ktb/platform/plugin-states";
import { packageLive } from "./plugin-state.ts";
import { Bot, stubBotDriver } from "@ktb/bot";
import { recallDriver } from "@ktb/bot-recall";
import { EvalArtifacts, EvalRunner, LlmFactory, LlmPort } from "@ktb/eval-consultation";
import { evalLlmAcpDriver } from "@ktb/ai-adapter-acp";
import {
	evalArtifactsLocalDriver,
	evalLlmFactoryDriver,
	evalRunnerLocalDriver,
} from "@ktb/eval-adapter-local";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Clock from "effect/Clock";
import { Binding, DbLive, makeDb, type SqlDatabase } from "@ktb/db";
import {
	makeAccountsService,
	makeApiKeysAdapter,
	makeAuth,
	makeAuthService,
} from "@ktb/auth-better";
import { Email, nullEmailDriver, type EmailMessage } from "@ktb/email";
import { cloudflareEmailDriver } from "@ktb/email-cloudflare";
import { smtpEmailDriver } from "@ktb/email-smtp";
import { stubEmailDriver } from "@ktb/email-stub";
import { Captcha, nullCaptchaDriver } from "@ktb/captcha";
import { stubCaptchaDriver } from "@ktb/captcha-stub";
import { turnstileCaptchaDriver } from "@ktb/captcha-turnstile";
import { EntityCipher } from "@ktb/crypto/cipher";
import { passthroughCipherDriver } from "@ktb/crypto-stub";
import { Accounts, ApiKeys, Auth } from "@ktb/auth";
import { AuthzLive, Principal } from "@ktb/authz";
import { Tenant, TenantResolver, type TenantResolverShape, type TenantSelector } from "@ktb/tenant";
import { AnamnesisEngine } from "@ktb/anamnesis/services";
import type { LlmConfig } from "@ktb/anamnesis-llm/services";
import { llmDrivers } from "@ktb/anamnesis-llm/drivers";
import { correctTranscript as correctTranscriptEffect } from "@ktb/anamnesis-llm";
import { correctTranscriptViaPlatform, platformPreferringEngine } from "./platform-llm.ts";
import {
	Command,
	CommandBus,
	makeCommandBus,
	makeEventBus,
	makeQueryBus,
	mergeDispatchTables,
	Middleware,
	Query,
	QueryBus,
	type DispatchTable,
} from "@effect-server-utils/cqrs";

/**
 * Plugin registry discovered from the filesystem: every module under
 * plugins/* exporting `plugins` (single-concern Plugin objects)
 * is registered, topo-sorted by `requiredDeps`/`optionalDeps`.
 * import.meta.glob is a build-time transform — Vite emits static imports,
 * so workerd bundling and type safety are preserved.
 *
 * @ktb/platform (packages/platform) is host infrastructure below the
 * plugin system, but its manifest still joins the registry — it is
 * registered explicitly here since the plugins/* glob no longer reaches
 * it (T-088).
 */
export const plugins: readonly Plugin[] = orderPlugins(
	discoverPlugins({
		// Every plugins/* entry joins the registry, eval packs included
		// (P-070): eval.* contributions ride the generic `contributions`
		// channel — data-only metadata this host never collects (its
		// consumers opt in per kind; see @ktb/kernel kinds.ts).
		...import.meta.glob("../../../plugins/*/src/index.ts", { eager: true }),
		"@ktb/platform": { plugins: platformPlugins },
	}),
);

// Route → i18n namespace derivation (PL-008): pure registry helpers,
// safe on both edges.
export * from "./namespaces.ts";

/**
 * CQRS groups are enumerated by convention, not by plugin objects: every
 * plugin api module (`plugins/<name>/src/api.ts`) may export query/command
 * group values, and the `isGroup` guards (provided by the library exactly for
 * host reflection) filter them out of each module's export surface.
 * Events need no enumeration — `EventBus` is already app-wide.
 */
const apiModules = import.meta.glob("../../../plugins/*/src/api.ts", { eager: true });
// Each api module belongs to a plugin PACKAGE (`plugins/<pkg>/src/api.ts`);
// the enabled-state gate below is package-granular — a package's CQRS
// surface is live while ANY of its plugin ids is enabled (P-058).
const apiEntries = Object.entries(apiModules).flatMap(([path, m]) => {
	const pkg = /(?:^|\/)plugins\/([^/]+)\/src\/api\.ts$/.exec(path)?.[1];
	/* v8 ignore next -- glob keys always match the plugins/<pkg>/src/api.ts shape */
	return pkg === undefined
		? []
		: Object.values(m as Record<string, unknown>).map((value) => ({ pkg, value }));
});
const queryGroups = apiEntries.flatMap(({ pkg, value }) =>
	Query.isGroup(value) ? [{ pkg, group: value }] : [],
);
const commandGroups = apiEntries.flatMap(({ pkg, value }) =>
	Command.isGroup(value) ? [{ pkg, group: value }] : [],
);

/** Minimal binding surface the host needs. Any platform (workerd, bun,
 * future adapters) supplies these; the host never touches cloudflare:*. */
export interface AppEnv extends ObservabilityEnv {
	readonly DB: SqlDatabase;
	readonly RECALL_API_KEY?: string;
	readonly BETTER_AUTH_SECRET?: string;
	readonly BETTER_AUTH_URL?: string;
	readonly CAPTCHA_STUB?: unknown;
	readonly TURNSTILE_SECRET_KEY?: string;
	/** Dev-only: log outbound email instead of delivering it. */
	readonly EMAIL_STUB?: unknown;
	/** Provider send binding (e.g. the Workers `send_email` binding). */
	readonly EMAIL?: unknown;
	/** Sender address for outbound email. */
	readonly EMAIL_FROM?: string;
	/** SMTP server URL — e.g. smtp://localhost:1025 against a dev mailpit. */
	readonly SMTP_URL?: string;
	/** Socket transport for the SMTP driver — the deploy target injects
	 * `cloudflare:sockets` connect (workerd) or its node:net stand-in. */
	readonly SMTP_CONNECT?: unknown;
	readonly ANTHROPIC_API_KEY?: string;
	readonly LLM_API_KEY?: string;
	readonly OPENAI_API_KEY?: string;
	readonly LLM_BASE_URL?: string;
	readonly LLM_MODEL?: string;
	readonly WORKERS_AI_MODEL?: string;
	/** Comma-separated admin allowlist for the /platform console (P-026). */
	readonly PLATFORM_ADMIN_EMAILS?: string;
	/** Workers AI binding — optional; any object with `run(model, inputs)`. */
	readonly AI?: {
		run(model: string, inputs: unknown): Promise<unknown>;
	};
}

/**
 * Bounded span attributes for the `http.access` span — scalar request
 * fields only. `path` stays a log annotation: raw pathnames carry ids
 * and would explode Tempo attribute cardinality; a route *template*
 * belongs in `TelemetryContext.route` once the edge seeds it.
 */
const ACCESS_SPAN_ATTRIBUTE_KEYS = ["method", "handlerType", "status", "durationMs"] as const;

const accessSpanAttributes = (
	fields: Readonly<Record<string, unknown>>,
): Record<string, string | number> => {
	const out: Record<string, string | number> = {};
	for (const key of ACCESS_SPAN_ATTRIBUTE_KEYS) {
		const value = fields[key];
		if (typeof value === "string" || typeof value === "number") out[key] = value;
	}
	return out;
};

/**
 * Production must never run without a bot check: with neither
 * CAPTCHA_STUB nor TURNSTILE_SECRET_KEY the null captcha driver resolves
 * Captcha to null and credential endpoints (/api/auth/*) would skip
 * verification entirely — fail-open. CAPTCHA_STUB is dev-only (never
 * bound by the Alchemy stack); TURNSTILE_SECRET_KEY comes from the cuora
 * vault. Dev/test keep the null driver.
 */
export const assertCaptchaConfigured = (
	env: Pick<AppEnv, "CAPTCHA_STUB" | "TURNSTILE_SECRET_KEY">,
	production: boolean,
): void => {
	if (production && !env.CAPTCHA_STUB && !env.TURNSTILE_SECRET_KEY) {
		throw new Error(
			"captcha not configured for production: bind TURNSTILE_SECRET_KEY " +
				"(CAPTCHA_STUB is dev-only and must never reach a prod deploy)",
		);
	}
};

/**
 * Production must never run without auth secrets: makeAuth passes
 * `secret`/`baseURL` straight through to better-auth, which only
 * hard-fails on the default secret when its own NODE_ENV detection
 * fires — an early, explicit assert here keeps a missing
 * BETTER_AUTH_SECRET/BETTER_AUTH_URL from silently falling back to
 * insecure defaults (or a runtime surprise) on a prod deploy.
 */
export const assertAuthConfigured = (
	env: Pick<AppEnv, "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL">,
	production: boolean,
): void => {
	if (production && (!env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL)) {
		throw new Error(
			"auth not configured for production: bind BETTER_AUTH_SECRET and " +
				"BETTER_AUTH_URL (better-auth falls back to insecure defaults otherwise)",
		);
	}
};

/**
 * `import.meta.env` only exists inside the Vite pipeline — under plain
 * node/bun the property is undefined and a bare `import.meta.env.PROD`
 * read throws TypeError. Callers pass the (possibly absent) env object;
 * exported so tests can exercise both shapes.
 */
export const isProductionBuild = (env: { readonly PROD?: unknown } | undefined): boolean =>
	env?.PROD === true;

/** Subject and body of a transactional email, before addressing. */
export type EmailContent = Omit<EmailMessage, "to">;

/** Default (English) verification email — apps override it through
 * `AppOptions.verificationEmail` to localize or brand the copy. */
export const defaultVerificationEmail = (input: {
	readonly name: string | null;
	readonly url: string;
}): EmailContent => ({
	subject: "Confirm your email — KTB Health",
	text: [
		input.name ? `Hello, ${input.name}.` : "Hello.",
		"",
		"Confirm your email address to finish setting up your KTB Health account:",
		input.url,
		"",
		"If you did not create this account, you can ignore this message.",
	].join("\n"),
});

export interface AppOptions {
	/**
	 * Optional tenant resolver (P-053): when provided, `runAs` resolves
	 * the request's tenant selector through it inside the per-request
	 * effect scope and binds `Tenant` next to `Principal`. Apps build it
	 * with `makeTenantResolver`/`TenantResolverLive` from @ktb/tenant.
	 * Absent → the default resolver yields `null` (personal scope) and
	 * `runAs` behaves exactly as before.
	 */
	readonly tenantResolver?: TenantResolverShape;
	/** Composes the sign-up verification email. Defaults to
	 * {@link defaultVerificationEmail}. May be async — apps resolve
	 * localized copy from the DB i18n catalog at send time (PL-008). */
	readonly verificationEmail?: (input: {
		readonly name: string | null;
		readonly url: string;
	}) => EmailContent | Promise<EmailContent>;
}

/**
 * Composition root: wires the plugin registry, platform bindings, and
 * impl layers into a runnable app. Deploy targets (apps/web) call this
 * once with their env and re-export the pieces they need.
 */
export const createApp = <E extends AppEnv>(env: E, options?: AppOptions) => {
	// isProductionBuild reads import.meta.env.PROD safely: the Vite build
	// statically replaces it (true for `vp build`/`vp preview` output —
	// prod deploy — false for dev servers and vitest), while runtimes
	// outside the Vite pipeline get `undefined` instead of a TypeError.
	// Same convention as the stub-bot guard in apps/web routes.
	// The cast widens the ambient ImportMeta type (env.d.ts declares
	// env as always-present for the vite/client case) so the possibly-
	// absent runtime shape typechecks.
	const production = isProductionBuild((import.meta as { env?: { PROD?: unknown } }).env);
	assertCaptchaConfigured(env, production);
	assertAuthConfigured(env, production);
	const BindingLive = Layer.succeed(Binding, env.DB);
	const db = makeDb(env.DB);

	// Port→impl selection is data: impl packages export Driver descriptors
	// and the first enabled driver for a port wins (array order is the
	// tie-break). Ordering encodes precedence — e.g. the captcha stub
	// before Turnstile before the disabled verifier; LLM drivers carry
	// their own when predicates mirroring the old factory branches.
	// Auth and Db stay manual on purpose: they are single-impl ports
	// wrapping live instances built here (the better-auth object the
	// routes call directly; the drizzle client over the SqlDatabase
	// binding), not env-selectable adapters. Engine variance already
	// lives at the edges — SqlDatabase at `Binding`, better-auth config
	// in makeAuth — and tests stub these ports via Layer.succeed, which
	// needs no driver descriptor. Putting them in the registry would add
	// indirection with no second impl to select between.
	const drivers: readonly Driver<unknown>[] = [
		recallDriver,
		stubBotDriver,
		stubCaptchaDriver,
		turnstileCaptchaDriver,
		nullCaptchaDriver,
		smtpEmailDriver,
		stubEmailDriver,
		cloudflareEmailDriver,
		nullEmailDriver,
		...llmDrivers,
		// Telemetry port: OTLP exporter wins when an endpoint is bound;
		// the console driver is the always-eligible local/DX fallback.
		otlpTelemetryDriver,
		telemetryConsoleDriver,
		// Entity cipher (PL-007 F2): the passthrough is the non-ZK
		// default — always eligible, LAST in the list once real
		// keyring-backed drivers arrive (first eligible wins).
		passthroughCipherDriver,
		// Eval validator runner (P-081): eligible only when the local
		// pipeline env is wired (EVAL_RUNNER_DIR + EVAL_ASR_BASE_URL);
		// otherwise no EvalRunner is bound and eval runs stay queued.
		evalRunnerLocalDriver,
		// Same env gate, read side: serves run audio to the validator UI.
		evalArtifactsLocalDriver,
		// Generative script path for persona cohorts — bound only when
		// EVAL_ACP_URL points at an agent; otherwise the validator falls
		// back to the deterministic template renderer.
		evalLlmAcpDriver,
		// Endpoint factory for the eval lab — always eligible; it only
		// resolves descriptor rows into LlmPort layers on demand, so
		// binding it carries no env requirement of its own.
		evalLlmFactoryDriver,
	];
	// Drivers are type-erased (Layer.Any); each port maps to exactly one
	// service, so the concrete layer type is restored here — same shape
	// the hand-written ternaries used to produce.
	const layerFor = <S>(port: string, driverEnv: unknown): Layer.Layer<S, never, never> =>
		requireDriver(drivers, port, driverEnv).provides(driverEnv) as Layer.Layer<S, never, never>;

	// Optional ports — bound only when a driver is eligible for `env`
	// (requireDriver would throw on the absent case). EvalRunner is the
	// first: absent → the validator's run rows stay `queued`.
	const optionalLayerFor = <S>(port: string, driverEnv: unknown): Layer.Layer<S, never, never> =>
		(enabledDrivers(drivers, driverEnv)
			.find((d) => d.port === port)
			?.provides(driverEnv) ?? Layer.empty) as Layer.Layer<S, never, never>;

	// Bot check on credential endpoints. CAPTCHA_STUB (local dev var, never
	// set in the Alchemy stack) selects the stub; otherwise Turnstile when
	// its secret is bound; null skips verification entirely.
	const BotLive = layerFor<Bot>(Bot.key, env);
	const CaptchaLive = layerFor<Captcha>(Captcha.key, env);

	// Outbound email. SMTP_URL + EMAIL_FROM select the SMTP driver — an
	// explicit opt-in that wins over EMAIL_STUB (which stays the dev
	// default when no SMTP_URL is set); then the stub, then the provider
	// driver (EMAIL binding + EMAIL_FROM); null disables email — sign-up
	// then sends no verification.
	const EmailLive = layerFor<Email>(Email.key, env);
	const emailSender = Effect.runSync(Effect.service(Email).pipe(Effect.provide(EmailLive)));
	const verificationEmail = options?.verificationEmail ?? defaultVerificationEmail;
	const auth = makeAuth(db, {
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		...(emailSender === null
			? {}
			: {
					// A failed delivery must not fail the sign-up itself — the
					// account exists and the link can be requested again.
					sendVerificationEmail: async ({ email, name, url }) => {
						try {
							await emailSender.send({
								to: email,
								...(await verificationEmail({ name, url })),
							});
						} catch (error) {
							console.error("verification email failed", error);
						}
					},
				}),
	});

	// Plugin services compose in topo order: each plugin's layer is
	// provided the accumulated outputs of everything before it, so a
	// plugin can consume services provided by its `deps`.
	// Layer.Any is type-erased per plugin; requirements are still checked
	// when ManagedRuntime.make builds AppLive.
	const pluginLayer = plugins
		.map((p) => p.services as Layer.Layer<unknown, unknown, unknown> | undefined)
		.filter((s): s is NonNullable<typeof s> => s !== undefined)
		.reduce<Layer.Layer<unknown, unknown, unknown>>(
			(acc, svc) => Layer.merge(acc, svc.pipe(Layer.provideMerge(acc))),
			Layer.empty as unknown as Layer.Layer<unknown, unknown, unknown>,
		);
	// Infra layers are provided to plugin layers explicitly: mergeAll does
	// not wire one sibling's outputs into another's requirements.
	// Auth port backed by the same better-auth instance the routes use;
	// makeAuthService adds the banned-user enforcement + revocation (T-034).
	const AuthServiceLive = Layer.succeed(Auth, makeAuthService(auth, db));
	// Managed api-key store (better-auth apiKey plugin) — eval
	// credentials port; same auth instance/table.
	const ApiKeysLive = Layer.succeed(ApiKeys, makeApiKeysAdapter(auth, db));
	// Account provisioning over the same instance — what invite acceptance
	// creates accounts through.
	const AccountsLive = Layer.succeed(Accounts, makeAccountsService(auth));
	// LLM provider config is resolved here, once — impl packages never
	// read env themselves.
	const llmConfig: LlmConfig = {
		anthropicApiKey: env.ANTHROPIC_API_KEY,
		openAiApiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY,
		openAiBaseUrl: env.LLM_BASE_URL,
		openAiModel: env.LLM_MODEL,
		workersAi: env.AI,
		workersAiModel: env.WORKERS_AI_MODEL,
	};
	const envAnamnesisEngineLive = layerFor<AnamnesisEngine>(AnamnesisEngine.key, llmConfig);
	// F2: the ai-endpoints plugin's PlatformLlm capability wins over env
	// providers when a platform-default endpoint is configured; the
	// wrapped engine is the (b) env fallback → (c) heuristic path.
	const AnamnesisEngineLive = Layer.unwrap(
		Effect.map(AnamnesisEngine, (inner) =>
			Layer.succeed(AnamnesisEngine, platformPreferringEngine(inner)),
		),
	).pipe(Layer.provide(envAnamnesisEngineLive));
	// Telemetry port: driver-selected exporter set (OTLP when configured,
	// console JSON otherwise) — provides Logger/Tracer references, the
	// Telemetry service, metric instrumentation and KTB_LOG_LEVEL.
	const TelemetryLive = layerFor<Telemetry>(Telemetry.key, env);
	// Eval validator runner — absent unless the local pipeline env is
	// wired; the plugin then leaves run rows `queued` (P-081).
	const EvalRunnerLive = optionalLayerFor<EvalRunner>(EvalRunner.key, env);
	const EvalArtifactsLive = optionalLayerFor<EvalArtifacts>(EvalArtifacts.key, env);
	// Entity cipher port (T-140): passthrough until ZK keyring drivers
	// exist — plugins resolve it via serviceOption like other ports.
	const EntityCipherLive = layerFor<EntityCipher>(EntityCipher.key, env);
	// LLM script generation for persona cohorts — bound only when an
	// ACP endpoint is configured; the service degrades to templates.
	const LlmLive = optionalLayerFor<LlmPort>(LlmPort.key, env);
	// Endpoint factory for the eval lab — always bound (the driver is
	// always eligible); without it plugins fall back to template mode.
	const LlmFactoryLive = optionalLayerFor<LlmFactory>(LlmFactory.key, env);
	// Platform admin gate (P-026): env allowlist resolved once here; the
	// gate fails closed (Forbidden) when the list is unset/empty.
	const PlatformAdminLive = Layer.succeed(
		PlatformAdmin,
		makePlatformAdminGate(parsePlatformAdminEmails(env.PLATFORM_ADMIN_EMAILS)),
	);
	// Runtime plugin enable/config state (P-058): the service is built
	// from the discovered registry (ids, dep edges, meta.config schemas)
	// over the Db port — provided here so plugin layers, server fns and
	// the CQRS gate below all share one instance. `.pipe(Layer.provide(
	// DbLive))` wires the sibling Db output in explicitly (mergeAll does
	// not), leaving only `Binding` for the outer provideMerge.
	const PluginStatesLive = makePluginStatesLive(plugins).pipe(Layer.provide(DbLive));
	// Tenant resolution is opt-in: the app supplies a TenantResolverShape
	// (usually makeTenantResolver over its TenantDirectory adapter). When
	// absent the Reference default resolves null — personal scope.
	const TenantResolverLive =
		options?.tenantResolver === undefined
			? []
			: [Layer.succeed(TenantResolver, options.tenantResolver)];
	const core = Layer.mergeAll(
		BotLive,
		CaptchaLive,
		EmailLive,
		DbLive,
		AuthServiceLive,
		ApiKeysLive,
		AccountsLive,
		AnamnesisEngineLive,
		TelemetryLive,
		EvalRunnerLive,
		EvalArtifactsLive,
		EntityCipherLive,
		LlmLive,
		LlmFactoryLive,
		PlatformAdminLive,
		PluginStatesLive,
		// Cross-plugin event bus — plugins publish/subscribe via EventBus
		// inside their service layers (CQRS event surface).
		makeEventBus(),
		...TenantResolverLive,
	);
	// App-wide CQRS buses (P-049): each group's dispatcher is built once,
	// wrapped in shared middleware, folded into an erased DispatchTable,
	// and served as QueryBus/CommandBus for dynamic dispatch
	// (`bus.execute(Def, payload)`). Typed `dispatcher(Group)` remains
	// the preferred path — buses exist for callers that can't name a
	// group statically. `declaredIn` makes a group whose handlers were
	// never registered fail at boot instead of on first dispatch.
	//
	// Middleware cannot widen the error channel, so authz cannot live
	// here — handlers keep their own `requireCanAs` checks. What the bus
	// boundary CAN own uniformly is observability: commands log at info,
	// queries at debug, failures at warning.
	const busMiddleware: ReadonlyArray<Middleware.Middleware> = [
		(dispatch, { tag, side }) =>
			(payload) =>
				Effect.gen(function* () {
					const start = yield* Clock.currentTimeMillis;
					const exit = yield* Effect.exit(dispatch(payload));
					const elapsed = (yield* Clock.currentTimeMillis) - start;
					yield* record(tagged(cqrsDispatches, { side }), 1);
					yield* record(tagged(cqrsDispatchDuration, { side }), elapsed);
					if (Exit.isSuccess(exit)) {
						yield* side === "command"
							? Effect.logInfo("cqrs command", { tag })
							: Effect.logDebug("cqrs query", { tag });
						return exit.value;
					}
					yield* record(tagged(cqrsDispatchFailures, { side }), 1);
					yield* Effect.logWarning("cqrs dispatch failed", {
						tag,
						side,
						error: String(exit.cause),
					});
					return yield* Effect.failCause(exit.cause);
				}),
	];
	// Enabled-state gate (P-058): services layers always compose
	// (ManagedRuntime can't recompose per toggle), so dispatch is the
	// fail-closed seam — a group's handlers are unreachable while EVERY
	// plugin of its package (`plugins/<pkg>`) is disabled. Membership
	// resolves through the `pkg` stamp on discovered plugins (plugin ids
	// are not reliably namespaced — see packageLive), NOT an id-prefix
	// guess; the page dispatchers apply the same package contract. The
	// gate reads PluginStates per dispatch so toggles apply without
	// restart.
	//
	// `Middleware` is typed `(payload) => Effect<A, E>` — R=never — but
	// the bus executes inside the app runtime where core services are
	// provided; the cast is the same erasure `Layer.Any` plugin layers
	// already rely on.
	const pluginGate = (pkg: string): Middleware.Middleware => {
		const gate =
			<A, E>(
				dispatch: (payload: never) => Effect.Effect<A, E>,
			): ((payload: never) => Effect.Effect<A, E>) =>
			(payload) =>
				Effect.gen(function* () {
					const states = yield* PluginStates;
					const enabled = yield* states.enabledIds();
					if (!packageLive(plugins, enabled, pkg)) {
						return yield* Effect.fail(new PluginDisabled({ pluginId: pkg }));
					}
					return yield* dispatch(payload);
				}) as Effect.Effect<A, E>;
		return gate as Middleware.Middleware;
	};
	// Per-dispatch trace span: the cqrs library already opens
	// `command.<tag>`/`query.<tag>` spans, but they carry no plugin
	// attribution — this span groups handler time by owning package so a
	// request trace shows which plugin's CQRS surface ran. Attributes are
	// compile-time constants (message tag, package id); payloads never
	// reach a span. Runs inside the enabled-state gate so a disabled
	// package's dispatch fails without opening one.
	const traceSpan = (pkg: string): Middleware.Middleware => {
		const span: Middleware.Middleware =
			(dispatch, { tag, side }) =>
			(payload) =>
				dispatch(payload).pipe(
					Effect.withSpan(`cqrs.${side}`, {
						attributes: { "cqrs.name": tag, "ktb.plugin": pkg },
					}),
				);
		return span;
	};
	const busesLive = Layer.unwrap(
		Effect.gen(function* () {
			const queryTables = yield* Effect.forEach(queryGroups, ({ pkg, group }) =>
				Query.dispatcher(group, {
					middleware: [pluginGate(pkg), traceSpan(pkg), ...busMiddleware],
				}),
			);
			const commandTables = yield* Effect.forEach(commandGroups, ({ pkg, group }) =>
				Command.dispatcher(group, {
					middleware: [pluginGate(pkg), traceSpan(pkg), ...busMiddleware],
				}),
			);
			return Layer.mergeAll(
				Layer.succeed(
					QueryBus,
					makeQueryBus(mergeDispatchTables(...queryTables) as DispatchTable, {
						declaredIn: queryGroups.map(({ group }) => group),
					}),
				),
				Layer.succeed(
					CommandBus,
					makeCommandBus(mergeDispatchTables(...commandTables) as DispatchTable, {
						declaredIn: commandGroups.map(({ group }) => group),
					}),
				),
			);
		}),
	).pipe(Layer.provide(pluginLayer.pipe(Layer.provide(core))));
	const AppLive = Layer.mergeAll(core, pluginLayer.pipe(Layer.provide(core)), busesLive).pipe(
		Layer.provideMerge(BindingLive),
		// Logger/Tracer references come from the Telemetry driver layer
		// (console JSON + redaction locally, OTLP when configured) — no
		// hardcoded logger here so exporters stay deploy-configurable.
	);
	// Heterogeneous plugin layers can't be proven RIn-free at the type
	// level; unsatisfied requirements still fail at layer build time.
	const runtime = ManagedRuntime.make(AppLive as Layer.Layer<unknown, unknown, never>);

	/**
	 * Telemetry wrapper around every runtime invocation: binds the merged
	 * `TelemetryContext` (ambient + caller seed), stamps log annotations
	 * for correlation, opens an `app.<kind>` span parented to any inbound
	 * `traceparent`, and records invocation count/duration metrics — on
	 * success AND failure (`onExit`). Everything degrades silently when
	 * unconfigured: native tracer, console logger, prometheus scrape.
	 */
	const instrument = <A, E, R>(
		kind: "run" | "runAs",
		effect: Effect.Effect<A, E, R>,
		seed: TelemetryContextValue = {},
	): Effect.Effect<A, E, R> =>
		Effect.gen(function* () {
			const ambient = yield* TelemetryContext;
			const ctx: TelemetryContextValue = { ...ambient, ...seed };
			const start = yield* Clock.currentTimeMillis;
			const parent = externalSpanFromTraceparent(ctx.traceparent);
			const program = effect.pipe(
				Effect.provideService(TelemetryContext, ctx),
				Effect.annotateLogs(telemetryAnnotations(ctx)),
				Effect.withSpan(`app.${kind}`, {
					attributes: {
						"app.kind": kind,
						...(ctx.route === undefined ? {} : { "app.route": ctx.route }),
					},
					...(parent === undefined ? {} : { parent }),
				}),
			);
			return yield* program.pipe(
				Effect.onExit(() =>
					Effect.gen(function* () {
						const elapsed = (yield* Clock.currentTimeMillis) - start;
						yield* record(tagged(appInvocations, { kind }), 1);
						yield* record(tagged(appInvocationDuration, { kind }), elapsed);
					}),
				),
			);
		});

	/**
	 * Run an Effect program against the composed app runtime.
	 *
	 * System/unauthenticated paths only: provider webhooks (bot-token auth
	 * via `ownedByBot`), background simulation, LLM helpers reachable
	 * without a session. No `Principal` is bound — domain services that
	 * require a user will fail `Forbidden`; bot-channel methods that are
	 * authorized out-of-band (botId binding) are designed for this.
	 *
	 * `telemetry` seeds request-scoped context (request id, inbound
	 * traceparent) extracted by the app edge; a fresh id is generated
	 * when the caller supplies none so every invocation correlates.
	 */
	const run = <A, E>(
		effect: Effect.Effect<A, E, unknown>,
		telemetry?: TelemetryContextValue,
	): Promise<A> =>
		runtime.runPromise(
			instrument("run", effect, telemetry ?? { requestId: newRequestId() }) as Effect.Effect<
				A,
				E,
				never
			>,
		);

	/**
	 * Run an Effect program as an authenticated user: binds `Principal`,
	 * the user's `Authz` rules and the resolved `Tenant` for the duration
	 * of the effect, so domain services enforce authorization and tenant
	 * scoping themselves (defense in depth — handlers no longer need
	 * per-call `requireCan`/`scopedRepo` bypasses).
	 *
	 * `tenantSelector` is the opaque selector the route layer extracted
	 * from the request (see `tenantSelectorFromHeaders` in @ktb/tenant);
	 * it is resolved through the bound `TenantResolver` INSIDE the
	 * per-request effect scope — never cached across requests. Omit it
	 * (or pass `null`) for the resolver's default path; when no resolver
	 * is configured the tenant stays `null` (personal scope), preserving
	 * the pre-tenancy behavior.
	 *
	 * `user.actorId` marks delegated access (a secretary acting as the
	 * doctor `user.id`): authz and data scope bind to `user.id`, the
	 * actor is carried on `Principal.actorId`, and the tenant resolves
	 * for the actor — memberships belong to the person signed in. The
	 * caller is trusted to have validated the delegation, exactly as it
	 * is trusted for `user.id` (see `getDoctorUser` in @ktb/server-fns).
	 */
	const runAs = <A, E>(
		user: { readonly id: string; readonly email?: string; readonly actorId?: string },
		effect: Effect.Effect<A, E, unknown>,
		tenantSelector?: TenantSelector | null,
		telemetry?: TelemetryContextValue,
	): Promise<A> =>
		runtime.runPromise(
			Effect.gen(function* () {
				const resolver = yield* TenantResolver;
				const actorId = user.actorId ?? user.id;
				const tenant = yield* resolver.resolve(tenantSelector ?? null, actorId);
				return yield* instrument(
					"runAs",
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
							...(actorId === user.id ? {} : { actorId }),
						}),
						Effect.provideService(Tenant, tenant),
						Effect.provide(AuthzLive(user.id)),
					),
					{
						requestId: newRequestId(),
						...telemetry,
						userId: user.id,
						tenantId: tenant?.id ?? null,
					},
				) as Effect.Effect<A, E, never>;
			}),
		);

	/**
	 * LLM transcript cleanup (P-017) bound to the resolved provider
	 * config. System path — no principal; returns null when unconfigured
	 * or on provider failure (correctedTranscript stays null).
	 */
	const correctTranscript = (transcript: string) =>
		runtime.runPromise(
			// Platform-default endpoint first (F2); env providers on
			// absence/failure — both paths degrade to null, never reject.
			correctTranscriptViaPlatform(transcript).pipe(
				Effect.flatMap((res) =>
					res !== null ? Effect.succeed(res) : correctTranscriptEffect(llmConfig, transcript),
				),
			),
		);

	/**
	 * Drain telemetry exporters (OTLP batch queues) — bounded by each
	 * exporter's shutdown timeout, never rejects. Called by the worker
	 * entry via `ctx.waitUntil` after fetches and queue batches so
	 * buffered spans/logs/metrics aren't lost when an isolate freezes.
	 */
	const flushTelemetry = (): Promise<void> =>
		runtime.runPromise(
			Effect.gen(function* () {
				const telemetry = yield* Telemetry;
				yield* telemetry.flush;
			}).pipe(
				// `ignoreCause`, not `ignore`: a defect (e.g. a dying logger
				// inside the flush path) must not reject the promise handed
				// to `ctx.waitUntil`.
				Effect.ignoreCause,
			),
		);

	/**
	 * Edge access log (T-105): emits `http.access` through the configured
	 * logger set (console JSON + OTLP) for EVERY request — including
	 * routes that never enter `run`/`runAs`. The request middleware runs
	 * outside the Effect runtime, so it reaches this via the app's
	 * registered sink; the record flows through `CurrentLoggers` like
	 * any other log line and lands as OTLP log attributes. Never
	 * rejects: observability must not break the request path.
	 *
	 * Trace correlation: when the fields carry trace context (`traceparent`
	 * or a `traceId`+`spanId` pair — see `externalSpanFromLogFields`), the
	 * emission runs inside an `http.access` span parented to the inbound
	 * trace. That is what stamps the OTLP `LogRecord.traceId`/`spanId`
	 * fields Loki/Tempo correlate on — log annotations alone only reach
	 * attribute bags. Fields without trace context emit uncorrelated,
	 * exactly as before.
	 */
	const logAccess = (fields: Readonly<Record<string, unknown>>): Promise<void> => {
		const parent = externalSpanFromLogFields(fields);
		// `traceparent`/`spanId` are correlation *inputs*, not log data —
		// keep them out of the annotation bag (headers never reach logs);
		// `traceId` stays for the existing Loki derived-field contract.
		const { traceparent: _traceparent, spanId: _spanId, ...annotations } = fields;
		const log = Effect.logInfo("http.access").pipe(Effect.annotateLogs(annotations));
		const program =
			parent === undefined
				? log
				: log.pipe(
						Effect.withSpan("http.access", {
							parent,
							kind: "server",
							attributes: accessSpanAttributes(fields),
						}),
					);
		return runtime.runPromise(program).then(
			() => undefined,
			() => undefined,
		);
	};

	return {
		plugins,
		BindingLive,
		CaptchaLive,
		EmailLive,
		AppLive,
		runtime,
		run,
		runAs,
		correctTranscript,
		flushTelemetry,
		logAccess,
		db,
		auth,
	};
};
