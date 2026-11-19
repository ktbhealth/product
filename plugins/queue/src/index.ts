import { ListTodoIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import type { Forbidden } from "@ktb/authz";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, PlatformAdmin } from "@ktb/platform";

import { QueueAdmin, QueueAdminLive } from "./admin.ts";
import { QueuePlatformPage } from "./platform-page.tsx";

/**
 * Queue console services: the `QueueAdmin` port aggregates the signals
 * behind /platform/queue — the bound-transport registry probe, the
 * job_runs projection and the enqueue path. The dep edge orders it
 * after the env-composed admin gate.
 */
export const queueServicesPlugin = definePlugin({
	id: "queue.services",
	meta: { keywords: ["queue", "services"] },
	requiredDeps: [platformAdminPlugin.id],
	services: QueueAdminLive,
});

// Chrome contribution: the console sidebar entry lives in the
// `portal.sidebar` chrome region under the Concurrency group; the dep
// edge orders it after the shell like the other panel entries.
export const queueChromePlugin = definePlugin({
	id: "queue.chrome",
	meta: { keywords: ["queue", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "queue.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/queue",
					label: "Queue",
					icon: ListTodoIcon,
					group: "Concurrency",
				},
			},
		},
	],
});

// Panel (system console) contribution: /platform/queue is mounted by
// the platform plugin's physical route subtree; this plugin declares
// the page descriptor. The dep edge orders it after the shell and the
// queue services its loader consumes.
export const queuePanelPlugin = definePlugin({
	id: "queue.panel",
	meta: { keywords: ["queue", "ui"] },
	requiredDeps: [platformPanelPlugin.id, queueServicesPlugin.id],
	panel: {
		pages: [
			{
				id: "queue.jobs",
				path: "/platform/queue",
				component: QueuePlatformPage,
				// Hard 404 for non-admins — same contract as the /platform
				// layout guard; every service call re-checks anyway.
				guard: () =>
					Effect.gen(function* () {
						const platformAdmin = yield* PlatformAdmin;
						return yield* platformAdmin.requireAdmin().pipe(
							Effect.as(true),
							Effect.catchTag("Forbidden", () => Effect.succeed(false)),
						);
					}),
				loader: () =>
					Effect.gen(function* () {
						const admin = yield* QueueAdmin;
						// Each section degrades independently: a Forbidden
						// yields null → the view renders the unavailable
						// state, never a fabricated empty list.
						const section = <A>(effect: Effect.Effect<A, Forbidden>) =>
							effect.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null as A | null)));
						const [queues, runs, kinds] = yield* Effect.all(
							[section(admin.queues()), section(admin.jobRuns()), section(admin.kinds())],
							{ concurrency: "unbounded" },
						);
						return { queues, runs, kinds };
					}),
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	queueServicesPlugin,
	queueChromePlugin,
	queuePanelPlugin,
];

export { QueueAdmin } from "./admin.ts";
export { enqueueJobFn } from "./fns.ts";
export type { EnqueueJobResult, QueueRunFilter } from "./admin.ts";
export type { QueuePageData } from "./platform-page.tsx";

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"queue.services": true;
		"queue.chrome": true;
		"queue.panel": true;
	}
}
