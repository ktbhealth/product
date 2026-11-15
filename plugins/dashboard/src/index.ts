import * as Effect from "effect/Effect";
import { Option } from "effect";

import { Principal } from "@ktb/authz";
import {
	Consultations,
	consultationsServicesPlugin,
	type AdminConsultationRow,
} from "@ktb/consultations";
import { definePlugin, type Plugin } from "@ktb/kernel";
import { Notifications, notificationsServicesPlugin, rowToConsole } from "@ktb/notifications";
import { Patients, patientsServicesPlugin, type AdminPatientRow } from "@ktb/patients";
import { platformPanelPlugin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";
import { LayoutDashboardIcon } from "lucide-react";

import { DashboardPlatformPage } from "./platform-page.tsx";

/**
 * Loader for the /platform index page (P-050): aggregates the same
 * data the retired route loader fetched via server fns — cross-owner
 * patient/consultation listings plus the session user's notification
 * activity. The admin gate lives in the /platform layout's beforeLoad
 * and inside each service's adminList; Forbidden collapses to the same
 * empty tables the old fns returned. Every source is optional: the
 * dashboard is a generic shell — missing patients/consultations/
 * notifications/plugin-state services degrade to empty sections
 * (feature absent ≠ error), and domain plugins extend the page through
 * the console.dashboard.* chrome regions rather than being required
 * by it.
 */
const dashboardLoader = () =>
	Effect.gen(function* () {
		// Every data source is optional: the dashboard is a generic shell
		// and domain plugins may be absent or disabled — each missing
		// service degrades to an empty section, never a failed loader.
		const patients = yield* Effect.serviceOption(Patients);
		const consultations = yield* Effect.serviceOption(Consultations);
		const [patientRows, consultationRows] = yield* Effect.all([
			Option.isSome(patients)
				? patients.value
						.adminList()
						.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as AdminPatientRow[])))
				: Effect.succeed([] as AdminPatientRow[]),
			Option.isSome(consultations)
				? consultations.value
						.adminList()
						.pipe(Effect.catchTag("Forbidden", () => Effect.succeed([] as AdminConsultationRow[])))
				: Effect.succeed([] as AdminConsultationRow[]),
		]);

		// Runtime enable-state per plugin (P-058) — optional like
		// notifications: the dashboard still renders without it (every
		// plugin then shows as enabled, matching the absence=enabled
		// default).
		const states = yield* Effect.serviceOption(PluginStates);
		const pluginStates = Option.isSome(states) ? yield* states.value.entries() : undefined;

		const notifications = yield* Effect.serviceOption(Notifications);
		const principal = yield* Principal;
		if (Option.isNone(notifications) || principal === null) {
			return {
				patients: patientRows,
				consultations: consultationRows,
				pluginStates,
				notifications: undefined,
				unreadCount: undefined,
			};
		}
		const [rows, unreadCount] = yield* Effect.all([
			notifications.value
				.list(principal.userId, 50)
				.pipe(Effect.map((list) => list.map(rowToConsole))),
			notifications.value.unreadCount(principal.userId),
		]);
		return {
			patients: patientRows,
			consultations: consultationRows,
			pluginStates,
			notifications: rows,
			unreadCount,
		};
	});

// Chrome contribution (P-060): the console sidebar entry lives in the
// `console.sidebar` chrome region; the dep edge orders it after the
// platform shell like the retired panel entry.
export const dashboardChromePlugin = definePlugin({
	id: "dashboard.chrome",
	requiredDeps: [platformPanelPlugin.id],
	chrome: [
		{
			id: "dashboard.sidebar",
			region: "console.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform",
					label: "Dashboard",
					icon: LayoutDashboardIcon,
					exact: true,
				},
			},
		},
	],
});

// Panel (system console) contribution: the console landing page
// (/platform) is dispatched by the host's generic panel.pages route;
// this plugin declares the page descriptor. Only the platform shell is
// a hard dep — every listing source (patients, consultations,
// notifications, plugin states) is optional so the dashboard renders
// as a generic shell and domain plugins extend it via the
// console.dashboard.* chrome regions instead of being required by it.
export const dashboardPanelPlugin = definePlugin({
	id: "dashboard.panel",
	requiredDeps: [platformPanelPlugin.id],
	optionalDeps: [
		patientsServicesPlugin.id,
		consultationsServicesPlugin.id,
		notificationsServicesPlugin.id,
	],
	panel: {
		pages: [
			{
				id: "dashboard.home",
				path: "/platform",
				component: DashboardPlatformPage,
				loader: dashboardLoader,
			},
		],
	},
});

/** Single-concern plugins contributed by this module — the host
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [dashboardChromePlugin, dashboardPanelPlugin];

// Compile-time dep registry: ids declared here are referenceable in
// requiredDeps/optionalDeps of any plugin that imports this module.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		"dashboard.chrome": true;
		"dashboard.panel": true;
	}
}
