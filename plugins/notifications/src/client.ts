import { definePlugin, type Plugin } from "@ktb/kernel";

import { NotificationsHeaderAction } from "./views/NotificationsHeaderAction.tsx";
import { NotificationsDashboardSections } from "./views/NotificationsDashboard.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Only the header action is
 * client-consumed; tables/services/routes degrade to markers (the
 * routes contribution is only consumed by route typegen). Dep ids are
 * literals: importing ./index.ts would pull the server graph into the
 * client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const notificationsHeaderPlugin = definePlugin({
	id: "notifications.header",
	meta: { keywords: ["notifications", "ui"] },
	requiredDeps: ["platform.panel"],
	optionalDeps: ["platform.header"],
	chrome: [
		{
			id: "notifications.header-action",
			region: "portal.header.actions",
			content: {
				kind: "headerAction",
				id: "notifications",
				component: NotificationsHeaderAction,
			},
		},
	],
});

export const notificationsDashboardPlugin = definePlugin({
	id: "notifications.dashboard",
	meta: { keywords: ["notifications", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "notifications.dashboard.sections",
			region: "portal.dashboard.sections",
			when: { paths: ["/platform"] },
			content: { kind: "component", component: NotificationsDashboardSections },
		},
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	notificationsHeaderPlugin,
	notificationsDashboardPlugin,
	definePlugin({ id: "notifications.tables", meta: { keywords: ["notifications", "tables"] } }),
	definePlugin({
		id: "notifications.services",
		meta: { keywords: ["notifications", "services"] },
	}),
	definePlugin({ id: "notifications.cqrs", meta: { keywords: ["notifications", "cqrs"] } }),
	definePlugin({ id: "notifications.routes", meta: { keywords: ["notifications", "routes"] } }),
];
