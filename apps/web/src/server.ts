import {
	createStartHandler,
	defaultStreamHandler,
	createServerEntry as createCoreServerEntry,
} from "@tanstack/react-start/server";
import type { Register } from "@tanstack/react-router";
import type { RequestHandler } from "@tanstack/react-start/server";

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
		// Dedicated theme-assets queue (PL-006 phase 4) dispatches to its
		// own kind registry; every other consumer binding is the shared
		// transcription/jobs transport.
		if (batch.queue === "ktb-theme-assets") {
			await handleThemeQueueBatch(batch.messages);
		} else {
			await handleAudioQueueBatch(batch.messages);
		}
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
