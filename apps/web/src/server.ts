import {
	createStartHandler,
	defaultStreamHandler,
	createServerEntry as createCoreServerEntry,
} from "@tanstack/react-start/server";
import type { Register } from "@tanstack/react-router";
import type { RequestHandler } from "@tanstack/react-start/server";

import { decodeJobEnvelope } from "@ktb/jobs-port";
import type { QueueMessage } from "@ktb/queues-port";
import { THEME_ASSET_JOB_KIND, THEME_FONT_JOB_KIND } from "@ktb/theme/assets";
import { handleAudioQueueBatch } from "#/lib/audio-jobs.ts";
import { handleThemeQueueBatch } from "#/lib/theme-jobs.ts";
import { flushTelemetry, runScheduledCron } from "#/lib/platform.ts";

// F3b: re-export the AcpBridge Durable Object class — the Alchemy
// `ACP_BRIDGE` binding points at this worker's `AcpBridge` export.
export { AcpBridge } from "@ktb/ai-bridge";
// P-094: the SchedulerDo Durable Object class — alarm-precision
// backstop for one-off scheduled_jobs run_at times. Bound as
// `SCHEDULER` in the Alchemy stack / wrangler.jsonc.
export { SchedulerDo } from "@ktb/scheduler-do";

const fetch = createStartHandler(defaultStreamHandler);

// Providing `RequestHandler` from `@tanstack/react-start/server` is required so that the output types don't import it from `@tanstack/start-server-core`
export type ServerEntry = { fetch: RequestHandler<Register> };

// Bind the shared request context and fallback error handling to React's Register.
export const createServerEntry: (entry: ServerEntry) => ServerEntry =
	createCoreServerEntry<Register>;

const entry = createServerEntry({ fetch });

/**
 * Kinds owned by the theme-assets pipeline (@ktb/theme/jobs). The
 * dedicated queue exists so image/font work never contends with audio,
 * but the CONSUMER must not key on `batch.queue`: that is the Cloudflare
 * queue NAME, which only matches the wrangler literals under `bun run
 * dev` — Alchemy-generated prod names differ, which misrouted every
 * theme batch into the audio consumer (unknown kind → acked failed).
 * Partitioning on the envelope kind routes correctly on every
 * transport; bodies that don't decode as envelopes fall through to the
 * audio consumer, whose normalizer still accepts legacy audio payloads
 * and acks true poison.
 */
const THEME_JOB_KINDS: ReadonlySet<string> = new Set([THEME_ASSET_JOB_KIND, THEME_FONT_JOB_KIND]);

/**
 * Custom worker entry (replaces TanStack's default server entry): same
 * fetch pipeline plus the Cloudflare Queue consumer for async audio
 * transcription (P-016). The default export object is the workerd
 * entrypoint — `queue` rides alongside `fetch`.
 *
 * Telemetry: after each fetch and queue batch, `ctx.waitUntil` schedules
 * a bounded OTLP flush so buffered spans/logs/metrics aren't lost when
 * the isolate freezes between requests.
 */
export default {
	...entry,
	fetch: ((request: Request, _env: unknown, ctx: ExecutionContext) => {
		const response = entry.fetch(request);
		const done = Promise.resolve(response).then(
			() => flushTelemetry(),
			() => flushTelemetry(),
		);
		ctx?.waitUntil?.(done);
		return response;
	}) as RequestHandler<Register>,
	queue: async (batch: MessageBatch, _env: unknown, ctx: ExecutionContext) => {
		const themeMessages: QueueMessage[] = [];
		const otherMessages: QueueMessage[] = [];
		for (const message of batch.messages) {
			const normalized = decodeJobEnvelope(message.body);
			const target =
				normalized !== null && THEME_JOB_KINDS.has(normalized.kind) ? themeMessages : otherMessages;
			target.push(message as QueueMessage);
		}
		if (themeMessages.length > 0) await handleThemeQueueBatch(themeMessages);
		if (otherMessages.length > 0) await handleAudioQueueBatch(otherMessages);
		ctx?.waitUntil?.(flushTelemetry());
	},
	// Cron triggers (Alchemy `crons` — see alchemy.run.ts, provisioned
	// from lib/cron-jobs.ts CRON_SCHEDULES) fire this handler once per
	// expression; the registry in lib/platform.ts dispatches every job
	// bound to the fired expression and projects each run into
	// job_runs. `scheduled()` never fires under `bun run dev`; the
	// agenda loaders poke the reminder sweep and /platform/cron offers
	// a manual "run now" for every registered job.
	scheduled: async (controller: ScheduledController, _env: unknown, ctx: ExecutionContext) => {
		await runScheduledCron(controller.cron);
		ctx?.waitUntil?.(flushTelemetry());
	},
};
