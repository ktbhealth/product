import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { makeSqliteDatabase } from "@ktb/db-sqlite";
import { connect as nodeSocketConnect } from "@ktb/email-smtp/node-connect";
import { OBSERVABILITY_ENV_KEYS } from "@ktb/observability";
import { createRedisJobsTransport } from "@ktb/jobs-transport-redis";
import { createRedisPubSubTransport } from "@ktb/pubsub-transport-redis";

import { resolveAi, type AiEnv } from "./ai.ts";
import { loadDevVars } from "./dev-vars.ts";
import { makeLocalAudioBucket } from "./node-audio.ts";
import { makeLocalQueue } from "./node-queue.ts";

/**
 * Node/Bun stand-in for the `cloudflare:workers` module — aliased in
 * vite.config.ts only when `KTB_DEV_NODE=1` (script: `dev:node`).
 * Everywhere else the real workerd module is used and this file is
 * never bundled.
 *
 * Exports the same `env` surface platform.ts consumes, backed by
 * process.env instead of worker bindings. `DB` is a real SQLite file
 * via @ktb/db-sqlite (better-sqlite3) — the explicit non-Cloudflare
 * dev path — with the drizzle migrations applied at boot.
 *
 * Bindings without a workerd runtime get local equivalents (see
 * node-audio.ts): AUDIO_BUCKET is a filesystem object store under
 * ./data/audio (gitignored; override with AUDIO_BUCKET_DIR), and
 * AUDIO_QUEUE is a SQLite-backed queue (node-queue.ts) dispatching to
 * the same consumer handler server.ts exports as `queue` — jobs
 * survive restarts and exhausted deliveries sit as `failed` rows (the
 * DLQ) in the queue db. AI still resolves through
 * AI_STUB/AI_BASE_URL in lib/ai.ts — Workers AI itself has no Node
 * equivalent, so env.AI stays unset unless a stand-in resolves
 * (mirroring wrangler.dev.jsonc, which drops the binding).
 */

// Repo root from apps/web/src/lib → packages/db/drizzle holds the
// drizzle-kit migrations (+ meta/_journal.json ordering).
const MIGRATIONS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/db/drizzle",
);

// apps/web/.dev.vars is what `dev:secrets` writes for workerd/miniflare;
// under dev:node nothing loads it, so merge it here — real env vars win
// (see dev-vars.ts). Key names only; values are never logged.
const devVarsFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../.dev.vars");
const devVarsKeys = loadDevVars(devVarsFile);
if (devVarsKeys.length > 0) {
	console.info(`[dev:node] loaded .dev.vars (${devVarsKeys.length} keys)`);
}

// Plain config/secrets process.env → worker-binding shape. Only keys
// the app actually reads are forwarded.
const ENV_KEYS = [
	"BETTER_AUTH_SECRET",
	"BETTER_AUTH_URL",
	"TURNSTILE_SECRET_KEY",
	"CAPTCHA_STUB",
	"ANTHROPIC_API_KEY",
	"LLM_API_KEY",
	"OPENAI_API_KEY",
	"LLM_BASE_URL",
	"LLM_MODEL",
	"WORKERS_AI_MODEL",
	"RECALL_API_KEY",
	"PLATFORM_ADMIN_EMAILS",
	"AUDIO_TRANSCRIBE_MODEL",
	"AI_STUB",
	"AI_BASE_URL",
	"SMTP_URL",
	"EMAIL_FROM",
	"EMAIL_STUB",
	// Eval pipeline drivers (eval-adapter-local): runner dir + ASR
	// service gate evalRunnerLocalDriver/evalArtifactsLocalDriver;
	// EVAL_ACP_URL gates the generative script path; SYSTEMONE is the
	// alternative ASR provider. Without these the shim can never bind
	// the drivers — validator runs would stay `queued` forever.
	"EVAL_RUNNER_DIR",
	"EVAL_ASR_BASE_URL",
	"EVAL_ASR_TIMEOUT_MS",
	"EVAL_ACP_URL",
	"EVAL_KEY",
	"EVAL_SYSTEMONE_URL",
	"EVAL_SYSTEMONE_MODEL",
	// Optional override for the minted `ai-bridge connect` argv prefix
	// (see ServerRuntime.aiBridgeCli); platform.ts auto-resolves the
	// repo's cli.ts under vite dev, this is the explicit escape hatch.
	"AI_BRIDGE_CLI",
	// Redis jobs transport (dev:node): REDIS_URL/JOBS_QUEUE configure the
	// ktb:jobs list apps/jobs-worker consumes; platform.ts turns them
	// into the queue-registry entry behind /platform/queue.
	"REDIS_URL",
	"JOBS_QUEUE",
	// Every ObservabilityEnv key — telemetryConfigFromEnv reads them off
	// the worker env, so dev:node must forward the full canonical list
	// (single source in @ktb/observability, pinned by its tests).
	...OBSERVABILITY_ENV_KEYS,
	"METRICS_SCRAPE_TOKEN",
] as const;

const env: Record<string, unknown> = {};
for (const key of ENV_KEYS) {
	const value = process.env[key];
	if (value !== undefined) env[key] = value;
}

// Dev-only stub defaults, mirroring wrangler.dev.jsonc vars so
// `bun run dev:node` runs the golden path with zero external services
// (regulamento: judges must be able to run the repo locally). Explicit
// env always wins: AI_STUB=0 + AI_BASE_URL=… runs a real local model,
// AI_STUB=0 alone disables the AI stand-in. SMTP_URL still beats
// EMAIL_STUB via driver precedence.
env.CAPTCHA_STUB ??= "1";
env.EMAIL_STUB ??= "1";
if (env.AI_STUB === undefined && env.AI_BASE_URL === undefined) env.AI_STUB = "1";

// DATABASE_URL selects the SQLite file (default ./data/app.db relative
// to apps/web — the historical dev location). `sqlite:`/`file:` URLs
// and `:memory:` are accepted; see @ktb/db-sqlite sqliteFilename.
env.DB = makeSqliteDatabase({
	filename: process.env.DATABASE_URL ?? "./data/app.db",
	migrate: MIGRATIONS_DIR,
});

// R2 stand-in: object bytes as files under apps/web/data/audio
// (gitignored via the root `data/` rule). AUDIO_BUCKET_DIR overrides —
// same convention as DATABASE_URL picking the SQLite file.
const AUDIO_DIR =
	process.env.AUDIO_BUCKET_DIR ??
	resolve(dirname(fileURLToPath(import.meta.url)), "../../data/audio");
env.AUDIO_BUCKET = makeLocalAudioBucket(AUDIO_DIR);

// Queue stand-in: send() resolves immediately; a poller delivers due
// rows to the same consumer handler server.ts wires as the workerd
// `queue` export. Jobs persist in a dedicated SQLite file —
// apps/web/data/queue.db (gitignored via the root `data/` rule;
// override with KTB_DEV_QUEUE_DB, same convention as DATABASE_URL /
// AUDIO_BUCKET_DIR). Rows that exhaust retries stay as status='failed'
// — the dead-letter queue; inspect/replay via the sqlite3 CLI.
// audio-jobs.ts imports platform.ts (which imports this module), so the
// import is deferred to delivery time — a static import would be a
// cycle.
env.AUDIO_QUEUE = makeLocalQueue({
	dbPath:
		process.env.KTB_DEV_QUEUE_DB ??
		resolve(dirname(fileURLToPath(import.meta.url)), "../../data/queue.db"),
	loadHandler: async () => {
		const { handleAudioQueueBatch } = await import("./audio-jobs.ts");
		return handleAudioQueueBatch;
	},
});

// Theme asset storage + dedicated queue stand-ins (PL-006 phase 4):
// same local-object-store and SQLite-queue shapes as audio, but separate
// files so theme derivatives never mix with consultation recordings.
// THEME_ASSETS_BUCKET_DIR / KTB_DEV_THEME_QUEUE_DB override the
// locations, same convention as AUDIO_BUCKET_DIR / KTB_DEV_QUEUE_DB.
const THEME_DIR =
	process.env.THEME_ASSETS_BUCKET_DIR ??
	resolve(dirname(fileURLToPath(import.meta.url)), "../../data/theme-assets");
env.THEME_ASSETS_BUCKET = makeLocalAudioBucket(THEME_DIR);
env.THEME_ASSETS_QUEUE = makeLocalQueue({
	dbPath:
		process.env.KTB_DEV_THEME_QUEUE_DB ??
		resolve(dirname(fileURLToPath(import.meta.url)), "../../data/theme-queue.db"),
	queue: "ktb-theme-assets",
	loadHandler: async () => {
		const { handleThemeQueueBatch } = await import("./theme-jobs.ts");
		return handleThemeQueueBatch;
	},
});

// Media-library image storage stand-in (P-111): same local-object-store
// shape as audio/theme, separate directory so site images never mix
// with recordings or brand assets. IMAGES_BUCKET_DIR overrides, same
// convention as AUDIO_BUCKET_DIR / THEME_ASSETS_BUCKET_DIR.
const IMAGES_DIR =
	process.env.IMAGES_BUCKET_DIR ??
	resolve(dirname(fileURLToPath(import.meta.url)), "../../data/images");
env.IMAGES_BUCKET = makeLocalAudioBucket(IMAGES_DIR);

// Redis jobs queue probe (dev:node only): apps/jobs-worker consumes the
// ktb:jobs list off Redis; LLEN gives the pending backlog for the
// /platform queue registry. The transport connects lazily on the first
// stats call so an absent Redis never blocks boot, and a failed connect
// resolves null — the registry's honest "unavailable" state, same
// contract as the other probes. This file is never bundled for workerd
// (the cloudflare:workers alias only applies under KTB_DEV_NODE), so
// the node Redis client is safe to import here.
let redisJobsTransport: ReturnType<typeof createRedisJobsTransport> | undefined;
const redisJobsQueue = () => {
	redisJobsTransport ??= createRedisJobsTransport({
		url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
		...(process.env.JOBS_QUEUE !== undefined ? { queue: process.env.JOBS_QUEUE } : {}),
	}).catch((error: unknown) => {
		// Let the next stats call retry instead of caching the failure.
		redisJobsTransport = undefined;
		throw error;
	});
	return redisJobsTransport;
};
env.REDIS_JOBS_QUEUE = {
	stats: async () => {
		try {
			return await (await redisJobsQueue()).stats();
		} catch {
			return null;
		}
	},
};

// Redis pub/sub stand-in (dev:node only): PUBSUB CHANNELS/NUMSUB give the
// /platform/pubsub console real cross-process topics — the same Redis
// instance apps/jobs-worker (or any second process) can publish to.
// Connects lazily on first use so an absent Redis never blocks boot;
// a failed connect rejects the call, which platform.ts collapses to the
// honest "unavailable" state. Never bundled for workerd.
let redisPubSubTransport: ReturnType<typeof createRedisPubSubTransport> | undefined;
const redisPubSub = () => {
	redisPubSubTransport ??= createRedisPubSubTransport({
		url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
	}).catch((error: unknown) => {
		// Let the next call retry instead of caching the failure.
		redisPubSubTransport = undefined;
		throw error;
	});
	return redisPubSubTransport;
};
env.REDIS_PUBSUB = {
	publish: async (topic: string, payload: unknown) => {
		await (await redisPubSub()).publish(topic, payload);
	},
	subscribe: async (topic: string, handler: (payload: unknown) => void | Promise<void>) => {
		const transport = await redisPubSub();
		if (transport.subscribe === undefined) return () => {};
		return transport.subscribe(topic, handler);
	},
	listTopics: async () => (await redisPubSub()).listTopics(),
};

// AI: platform.ts runs resolveAi(env) itself (AI_STUB > AI_BASE_URL >
// env.AI). Resolve the stand-in here too so env.AI carries it for any
// raw-env reader; when nothing is configured env.AI stays undefined —
// same as wrangler.dev.jsonc dropping the binding — and consumers keep
// their honest "not configured" paths instead of a throwing stub.
const aiStandIn = resolveAi(env as AiEnv);
if (aiStandIn !== undefined) env.AI = aiStandIn;

// Socket transport for the SMTP email driver (node:net stand-in for
// workerd's cloudflare:sockets connect — see @ktb/email-smtp). Bound
// unconditionally; the driver only reads it when SMTP_URL is set.
env.SMTP_CONNECT = nodeSocketConnect;

export { env };
