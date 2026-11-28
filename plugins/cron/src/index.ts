import { CalendarClockIcon } from "lucide-react";
import * as Effect from "effect/Effect";

import type { Forbidden } from "@ktb/authz";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { platformAdminPlugin, platformPanelPlugin, adminConsolePage } from "@ktb/platform";

import { CronAdmin, CronAdminLive } from "./admin.ts";
import { CronPlatformPage } from "./platform-page.tsx";

/**
 * Cron console services: the `CronAdmin` port aggregates the signals
 * behind /platform/cron — the scheduled-job registry probe, the
 * `cron.*` job_runs projection and the manual run-now path. The dep
 * edge orders it after the env-composed admin gate.
 */
export const cronServicesPlugin = definePlugin({
	id: "cron.services",
	meta: { keywords: ["cron", "services"] },
	requiredDeps: [platformAdminPlugin.id],
	services: CronAdminLive,
});

// Chrome contribution: the console sidebar entry lives in the
// `portal.sidebar` chrome region under the Concurrency group; the dep
// edge orders it after the shell like the other panel entries.
export const cronChromePlugin = definePlugin({
	i18nKeys: {
		labels: {
			"/platform/cron": "panel_nav_cron",
		},
		groups: { Concurrency: "panel_group_concurrency" },
	},
	id: "cron.chrome",
	meta: { keywords: ["cron", "ui"] },
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "cron.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/cron",
					label: "Cronjobs",
					icon: CalendarClockIcon,
					group: "Concurrency",
				},
			},
		},
	],
});

// Panel (system console) contribution: /platform/cron is mounted by
// the platform plugin's physical route subtree; this plugin declares
// the page descriptor. The dep edge orders it after the shell and the
// cron services its loader consumes.
export const cronPanelPlugin = definePlugin({
	id: "cron.panel",
	meta: { keywords: ["cron", "ui"] },
	requiredDeps: [platformPanelPlugin.id, cronServicesPlugin.id],
	panel: {
		pages: [
			adminConsolePage({
				id: "cron.jobs",
				path: "/platform/cron",
				component: CronPlatformPage,
				// Hard 404 for non-admins — same contract as the /platform
				// layout guard; every service call re-checks anyway.
				loader: () =>
					Effect.gen(function* () {
						const admin = yield* CronAdmin;
						// Each section degrades independently: a Forbidden
						// yields null → the view renders the unavailable
						// state, never a fabricated empty list.
						const section = <A>(effect: Effect.Effect<A, Forbidden>) =>
							effect.pipe(Effect.catchTag("Forbidden", () => Effect.succeed(null as A | null)));
						const [runs, entries, scheduleKinds, schedulableKinds] = yield* Effect.all(
							[
								section(admin.runs()),
								section(admin.entries()),
								section(admin.scheduleKinds()),
								section(admin.schedulableKinds()),
							],
							{ concurrency: "unbounded" },
						);
						return { runs, entries, scheduleKinds, schedulableKinds };
					}),
			}),
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [cronServicesPlugin, cronChromePlugin, cronPanelPlugin];

export { CronAdmin } from "./admin.ts";
export { runCronJobFn } from "./fns.ts";
export type { CronPageData } from "./platform-page.tsx";
export type { CronRunNowResult } from "./admin.ts";

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"cron.services": true;
		"cron.chrome": true;
		"cron.panel": true;
	}
}
