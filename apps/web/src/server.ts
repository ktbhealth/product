import {
	createStartHandler,
	defaultStreamHandler,
	createServerEntry as createCoreServerEntry,
} from "@tanstack/react-start/server";
import type { Register } from "@tanstack/react-router";
import type { RequestHandler } from "@tanstack/react-start/server";

import { runScheduledAuditVerification } from "#/lib/audit-chain.ts";
import { runScheduledAgendaReminders } from "#/lib/agenda-reminders.ts";
import { handleAudioQueueBatch } from "#/lib/audio-jobs.ts";
import { handleThemeQueueBatch } from "#/lib/theme-jobs.ts";
import { flushTelemetry } from "#/lib/platform.ts";

// F3b: re-export the AcpBridge Durable Object class — the Alchemy
// `ACP_BRIDGE` binding points at this worker's `AcpBridge` export.
export { AcpBridge } from "@ktb/ai-bridge";

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
	// Two cron triggers (Alchemy `crons` — see alchemy.run.ts): a 5-minute
	// sweep that dispatches "about to start" agenda reminders
	// (lib/agenda-reminders.ts — idempotent via reminderSentAt) and a
	// daily walk of the tamper-evident audit chain (lib/audit-chain.ts).
	// The reminder sweep also runs on the daily fire — it is cheap and
	// idempotent. `scheduled()` never fires under `bun run dev`; the
	// agenda loaders poke the same sweep so dev reminders stay live.
	scheduled: async (controller: ScheduledController, _env: unknown, ctx: ExecutionContext) => {
		await runScheduledAgendaReminders();
		if (controller.cron === "17 3 * * *") await runScheduledAuditVerification();
		ctx?.waitUntil?.(flushTelemetry());
	},
};
