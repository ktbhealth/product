import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { deploySqlDatabase, deployWorker } from "@ktb/infra-cloudflare";

import { CRON_SCHEDULES } from "./src/lib/cron-jobs.ts";

export default Alchemy.Stack(
	"ktb-web",
	{
		providers: Cloudflare.providers(),
		state: Cloudflare.state(),
	},
	Effect.gen(function* () {
		const { db } = yield* deploySqlDatabase({
			name: "db",
			migrationsDir: "../../packages/db/alchemy-migrations",
		});

		// Consultation audio storage (P-015) + async transcription queue
		// (P-016). Private bucket — reads only through authenticated
		// worker routes; the queue's consumer is this same worker script.
		// PL-007 F4/T-150: abort multipart uploads stranded for over a
		// week — incomplete uploads bill storage and would hold the
		// bucket non-empty on destroy. Object locks stay unconfigured on
		// purpose: any lock would also block the purge path that runs on
		// consultation deletion (see infra/cloudflare/DISASTER_RECOVERY.md).
		const audioBucket = yield* Cloudflare.R2.Bucket("audio", {
			lifecycleRules: [
				{
					id: "abort-incomplete-multipart-uploads",
					abortMultipartUploadsTransition: {
						condition: { type: "Age", maxAge: 604_800 },
					},
				},
			],
		});
		const transcriptionQueue = yield* Cloudflare.Queues.Queue("transcription");

		// ACP bridge (F3b): the durable object holding each ai_endpoint's
		// outbound agent socket (idFromName(endpointId)). The class is
		// exported as `AcpBridge` from the worker entry (src/server.ts).
		const acpBridge = Cloudflare.DurableObject("AcpBridge");

		// Scheduler DO (P-094): alarm-precision backstop for one-off
		// scheduled_jobs run_at times. Exported as `SchedulerDo` from the
		// worker entry (src/server.ts); the * * * * * heartbeat remains
		// the sweep of record — this only tightens one-off timing.
		const schedulerDo = Cloudflare.DurableObject("SchedulerDo");

		// Theme brand assets + font files (P-082/PL-006 phase 4): private
		// bucket served only through the worker's /api/theme/assets route;
		// dedicated queue (decided over sharing ktb-transcription) so image
		// derivatives and font downloads never contend with audio jobs.
		const themeAssetsBucket = yield* Cloudflare.R2.Bucket("theme-assets");
		// Media library (P-111): dedicated bucket for site images —
		// served only through the worker's /api/images/:id route, never
		// a public bucket URL. Derivatives (thumb/avif) are phase 2.
		const imagesBucket = yield* Cloudflare.R2.Bucket("images");
		// Logical id must differ from the "theme-assets" R2 bucket above —
		// alchemy logical ids are unique per stack regardless of type.
		const themeAssetsQueue = yield* Cloudflare.Queues.Queue("theme-assets-queue");

		// Outbound email (Cloudflare Email Service): the `send_email`
		// binding is restricted to the configured sender. EMAIL_FROM's
		// domain must be onboarded for sending in the Cloudflare account;
		// without EMAIL_FROM the worker runs with email disabled.
		const emailFrom = process.env.EMAIL_FROM;
		const email = emailFrom
			? yield* Cloudflare.Email.SendEmail("EMAIL", { allowedSenderAddresses: [emailFrom] })
			: undefined;

		// Prod defaults to the self-hosted LGTM collector behind the CF
		// tunnel (P-066/P-067, infra/lgtm → ktb-otel.luisfuturist.com); an
		// explicit OTEL_EXPORTER_OTLP_ENDPOINT always wins so local or
		// staging collectors can be targeted without code changes.
		// `Stage` is the alchemy-provided service — ALCHEMY_STAGE is NOT
		// set in process.env inside the stack program.
		const stage = yield* Alchemy.Stage;
		const otelEndpoint =
			process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
			(stage === "prod" ? "https://ktb-otel.luisfuturist.com" : undefined);
		const ktbEnvironment =
			process.env.KTB_ENVIRONMENT ?? (stage === "prod" ? "production" : undefined);

		const site = yield* deployWorker({
			name: "web",
			outdir: "dist/client",
			main: "dist/server/index.js",
			bundle: false,
			// Cron triggers fire the worker's `scheduled` handler
			// (src/server.ts), which dispatches through the registry in
			// lib/platform.ts. The expression set is DERIVED from
			// lib/cron-jobs.ts — the same metadata the runtime registry
			// reads — so adding a schedule to a job provisions the
			// trigger automatically. `scheduled()` never runs under
			// `bun run dev`; /platform/cron covers manual runs.
			crons: [...CRON_SCHEDULES],
			bindings: {
				DB: db,
				AI: Cloudflare.Workers.AI(),
				ACP_BRIDGE: acpBridge,
				SCHEDULER: schedulerDo,
				AUDIO_BUCKET: audioBucket,
				AUDIO_QUEUE: transcriptionQueue,
				THEME_ASSETS_BUCKET: themeAssetsBucket,
				THEME_ASSETS_QUEUE: themeAssetsQueue,
				IMAGES_BUCKET: imagesBucket,
				...(process.env.BETTER_AUTH_SECRET
					? { BETTER_AUTH_SECRET: Redacted.make(process.env.BETTER_AUTH_SECRET) }
					: {}),
				// Public base URL better-auth builds callback/reset links
				// from — config, not a secret (cuora ref: better-auth-url).
				...(process.env.BETTER_AUTH_URL ? { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL } : {}),
				...(email && emailFrom ? { EMAIL: email, EMAIL_FROM: emailFrom } : {}),
				...(process.env.TURNSTILE_SECRET_KEY
					? { TURNSTILE_SECRET_KEY: Redacted.make(process.env.TURNSTILE_SECRET_KEY) }
					: {}),
				// LLM provider config — bound as worker vars/secrets so
				// createApp's env mapping reaches them in production.
				...Object.fromEntries(
					[
						"ANTHROPIC_API_KEY",
						"LLM_API_KEY",
						"OPENAI_API_KEY",
						"LLM_BASE_URL",
						"LLM_MODEL",
						"WORKERS_AI_MODEL",
						"RECALL_API_KEY",
						"VAULT_MASTER_KEY",
					]
						.filter((k) => process.env[k])
						.map((k) => [k, Redacted.make(process.env[k] as string)]),
				),
				// /platform console admin allowlist (P-026) — plain config,
				// not a secret, but bound the same way for parity.
				...(process.env.PLATFORM_ADMIN_EMAILS
					? { PLATFORM_ADMIN_EMAILS: process.env.PLATFORM_ADMIN_EMAILS }
					: {}),
				// Product literals the generic infra packages consume via
				// config: the recall bot's display name, the env-var prefix
				// the observability config reads its KTB_* vars under, and
				// the binding name the SchedulerDo resolves its jobs queue
				// through (packages stay domain-blind; apps own the names).
				RECALL_BOT_NAME: "KTB Health",
				OBSERVABILITY_ENV_PREFIX: "KTB_",
				SCHEDULER_QUEUE_BINDING: "AUDIO_QUEUE",
				// Server-side transcription model override (plain config).
				...(process.env.AUDIO_TRANSCRIBE_MODEL
					? { AUDIO_TRANSCRIBE_MODEL: process.env.AUDIO_TRANSCRIBE_MODEL }
					: {}),
				// Observability (T-099): OTLP collector config — endpoint and
				// service name are plain config; headers + scrape token are
				// secrets. Unset everywhere → console/Prometheus fallback.
				...(otelEndpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint } : {}),
				...(process.env.OTEL_EXPORTER_OTLP_HEADERS
					? {
							OTEL_EXPORTER_OTLP_HEADERS: Redacted.make(process.env.OTEL_EXPORTER_OTLP_HEADERS),
						}
					: {}),
				...(process.env.OTEL_SERVICE_NAME
					? { OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME }
					: {}),
				...(ktbEnvironment ? { KTB_ENVIRONMENT: ktbEnvironment } : {}),
				...(process.env.KTB_TELEMETRY_TRACES_SAMPLE_RATE
					? { KTB_TELEMETRY_TRACES_SAMPLE_RATE: process.env.KTB_TELEMETRY_TRACES_SAMPLE_RATE }
					: {}),
				...(process.env.KTB_TELEMETRY_CLIENT_SAMPLE_RATE
					? {
							KTB_TELEMETRY_CLIENT_SAMPLE_RATE: process.env.KTB_TELEMETRY_CLIENT_SAMPLE_RATE,
						}
					: {}),
				...(process.env.OTEL_SDK_DISABLED
					? { OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED }
					: {}),
				...(process.env.METRICS_SCRAPE_TOKEN
					? { METRICS_SCRAPE_TOKEN: Redacted.make(process.env.METRICS_SCRAPE_TOKEN) }
					: {}),
				// Remaining ObservabilityEnv knobs — all plain config. Per-
				// signal endpoints matter because the TLS guard drops remote
				// http:// URLs; compression/resource-attributes/tuning vars
				// are optional but must be bindable to reach the worker.
				...Object.fromEntries(
					[
						"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
						"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
						"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
						"OTEL_EXPORTER_OTLP_COMPRESSION",
						"OTEL_RESOURCE_ATTRIBUTES",
						"KTB_TELEMETRY_EXPORT_INTERVAL_MS",
						"KTB_TELEMETRY_MAX_BATCH_SIZE",
						"KTB_TELEMETRY_SHUTDOWN_TIMEOUT_MS",
						"KTB_TELEMETRY_CLIENT",
						"KTB_TELEMETRY_RATE_LIMIT_PER_IP",
						"KTB_TELEMETRY_RATE_LIMIT_GLOBAL",
						"KTB_LOG_LEVEL",
					]
						.filter((k) => process.env[k])
						.map((k) => [k, process.env[k] as string]),
				),
			},
			// No explicit compatibility flags: Alchemy's default compat
			// date (2026-08-31) is past the nodejs_compat default-on date
			// (2026-08-04), so nodejs_compat_v2 — including
			// node:async_hooks, which the locale ALS uses — is implied.
			// Secrets still arrive only via bindings (.dev.vars in dev,
			// these bindings in prod); worker code never reads
			// process.env.
		});

		// Queue consumer → this worker's `queue` handler (src/server.ts).
		// scriptName may be an unresolved Output — Alchemy Input accepts it.
		if (site.scriptName) {
			yield* Cloudflare.Queues.Consumer("transcription-consumer", {
				queueId: transcriptionQueue.queueId,
				scriptName: site.scriptName as string,
				settings: { maxRetries: 3 },
			});
			yield* Cloudflare.Queues.Consumer("theme-assets-consumer", {
				queueId: themeAssetsQueue.queueId,
				scriptName: site.scriptName as string,
				settings: { maxRetries: 3 },
			});
		}

		return { url: site.url };
	}),
);
