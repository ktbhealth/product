import { definePlugin, type Plugin } from "@ktb/kernel";

/**
 * Client-safe mirror of ./index.ts — registered explicitly by
 * `@ktb/app-host/client` via the `@ktb/platform/client` subpath (this
 * package lives below the plugin system, so the plugins/* filesystem
 * glob does not reach it). None of the platform entries carry
 * client-consumed contributions the host reads at runtime (the routes
 * contribution is only consumed by route typegen), so every entry is a
 * marker preserving id and dep edges for topo order and feature checks.
 * Dep ids are literals: importing ./index.ts would pull the server
 * graph into the client bundle. Keep in sync — parity is asserted by
 * apps/web/src/plugins.test.ts.
 */
export const plugins: readonly Plugin[] = [
	definePlugin({
		id: "platform.admin",
		meta: { keywords: ["platform", "admin", "marker"] },
		system: true,
	}),
	definePlugin({ id: "platform.routes", meta: { keywords: ["platform", "routes"] }, system: true }),
	definePlugin({
		id: "platform.panel",
		meta: { keywords: ["platform", "marker"] },
		system: true,
		requiredDeps: ["platform.routes"],
	}),
	definePlugin({
		id: "platform.portal",
		meta: { keywords: ["platform", "shell"] },
		system: true,
		requiredDeps: ["platform.panel"],
		portals: [
			{
				id: "platform",
				basePath: "/platform",
				label: "Platform",
				audience: "platform-admin",
			},
		],
	}),
];
