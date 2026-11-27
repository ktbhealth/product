import { describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeTestD1 } from "@ktb/db-testing";

import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { makePluginStatesLive, PluginStates } from "@ktb/platform/plugin-states";
import { collectRouteDefinitions, makeRoutes, Routes } from "@ktb/platform/routes";
import { Principal } from "@ktb/authz";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { managerChromePlugin, managerPanelPlugin, plugins } from "./index.ts";
import { managerConfig, managerConfigSchema } from "./config.tsx";

describe("manager plugins", () => {
	it("declares the sidebar chrome and the /platform/plugins page", () => {
		expect(managerChromePlugin.id).toBe("manager.chrome");
		// The manager is the only re-enable UI — both entries are system plugins.
		expect(managerChromePlugin.system).toBe(true);
		expect(managerChromePlugin.chrome).toHaveLength(1);
		expect(managerChromePlugin.chrome[0]).toMatchObject({
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/plugins", label: "Plugins", group: "Runtime" },
			},
		});
		expect(managerPanelPlugin.id).toBe("manager.panel");
		expect(managerPanelPlugin.system).toBe(true);
		expect(managerPanelPlugin.panel?.pages?.[0]).toMatchObject({
			id: "manager.plugins",
			path: "/platform/plugins",
		});
	});

	it("carries meta for the manager list, including a JSON-Schema config doc", () => {
		expect(managerPanelPlugin.meta?.name).toBe("Plugin manager");
		// meta.config is the serializable projection shared with client.ts;
		// configSchema is the server-only effect/Schema it derives from.
		expect(managerPanelPlugin.meta?.config).toBe(managerConfig);
		expect(managerPanelPlugin.meta?.config?.schema.schema).toMatchObject({
			type: "object",
			properties: {
				cascadeConfirm: { type: "boolean", default: true },
			},
		});
		expect(managerPanelPlugin.configSchema).toBe(managerConfigSchema);
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual(["manager.chrome", "manager.panel"]);
	});
});

describe("manager page loader", () => {
	const loader = managerPanelPlugin.panel!.pages![0]!.loader!;

	const runtimeFor = (adminEmail?: string) =>
		ManagedRuntime.make(
			Layer.mergeAll(
				makePluginStatesLive(plugins).pipe(Layer.provide(Layer.succeed(Db, makeDb(makeTestD1())))),
				Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(adminEmail))),
			),
		);

	it("returns plugin states for an admin principal", async () => {
		const runtime = runtimeFor("admin@x.com");
		try {
			const data = await runtime.runPromise(
				loader().pipe(Effect.provideService(Principal, { userId: "u1", email: "admin@x.com" })),
			);
			expect(data).toEqual({
				states: [
					{ pluginId: "manager.chrome", enabled: true, system: true, config: null },
					{
						pluginId: "manager.panel",
						enabled: true,
						system: true,
						config: { cascadeConfirm: true },
					},
				],
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("fails Forbidden for a non-admin principal", async () => {
		const runtime = runtimeFor("admin@x.com");
		try {
			await expect(
				runtime.runPromise(
					loader().pipe(Effect.provideService(Principal, { userId: "u2", email: "user@x.com" })),
				),
			).rejects.toMatchObject({ _tag: "Forbidden" });
		} finally {
			await runtime.dispose();
		}
	});
});

describe("manager routes page loader", () => {
	const loader = managerPanelPlugin.panel!.pages![1]!.loader!;

	const runtimeFor = (adminEmail?: string) =>
		ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(Routes, makeRoutes(collectRouteDefinitions(plugins))),
				Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails(adminEmail))),
			),
		);

	it("declares the read-only /platform/routes page", () => {
		expect(managerPanelPlugin.panel?.pages?.[1]).toMatchObject({
			id: "manager.routes",
			path: "/platform/routes",
			routeKey: "manager.routes",
		});
	});

	it("returns the registered route defs for an admin principal", async () => {
		const runtime = runtimeFor("admin@x.com");
		try {
			const data = await runtime.runPromise(
				loader().pipe(Effect.provideService(Principal, { userId: "u1", email: "admin@x.com" })),
			);
			expect(data).toEqual([
				{
					key: "manager.panel/manager.plugins",
					path: "/platform/plugins",
					context: "portal",
					pluginId: "manager.panel",
				},
				{
					key: "manager.routes",
					path: "/platform/routes",
					context: "portal",
					pluginId: "manager.panel",
				},
			]);
		} finally {
			await runtime.dispose();
		}
	});

	it("fails Forbidden for a non-admin principal", async () => {
		const runtime = runtimeFor("admin@x.com");
		try {
			await expect(
				runtime.runPromise(
					loader().pipe(Effect.provideService(Principal, { userId: "u2", email: "user@x.com" })),
				),
			).rejects.toMatchObject({ _tag: "Forbidden" });
		} finally {
			await runtime.dispose();
		}
	});
});
