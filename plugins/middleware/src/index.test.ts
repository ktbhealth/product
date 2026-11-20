import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { MiddlewareStages } from "@ktb/platform/middleware";
import { PluginStates } from "@ktb/platform/plugin-states";

import { middlewarePanelPlugin, middlewareChromePlugin, plugins } from "./index.ts";

describe("middleware plugin manifests", () => {
	it("exports the panel and chrome plugins", () => {
		expect(plugins).toEqual([middlewarePanelPlugin, middlewareChromePlugin]);
		expect(middlewarePanelPlugin.id).toBe("middleware.panel");
		expect(middlewareChromePlugin.id).toBe("middleware.chrome");
	});

	it("declares the /platform/middleware console page", () => {
		const page = middlewarePanelPlugin.panel?.pages?.[0];
		expect(page?.id).toBe("middleware.stages");
		expect(page?.path).toBe("/platform/middleware");
		expect(typeof page?.guard).toBe("function");
		expect(typeof page?.loader).toBe("function");
	});

	it("declares the sidebar entry under Runtime", () => {
		const entry = middlewareChromePlugin.chrome?.[0];
		expect(entry?.region).toBe("portal.sidebar");
		if (entry?.content.kind !== "sidebarItem") throw new Error("expected sidebarItem content");
		expect(entry.content.item.to).toBe("/platform/middleware");
		expect(entry.content.item.group).toBe("Runtime");
	});
});

describe("middleware page guard", () => {
	const runGuard = async (isAdmin: boolean) => {
		const { PlatformAdmin } = await import("@ktb/platform");
		const effect = middlewarePanelPlugin.panel!.pages![0]!.guard!();
		return Effect.runPromise(
			effect.pipe(
				Effect.provideService(PlatformAdmin, {
					isAdmin: () => Effect.succeed(isAdmin),
					requireAdmin: () => (isAdmin ? Effect.void : Effect.fail({ _tag: "Forbidden" } as never)),
				} as never),
			),
		);
	};

	it("admits admins and hides the page from non-admins", async () => {
		// requireAdmin fails with a Forbidden-tagged error; the guard
		// catches it into `false` — same contract as other console pages.
		await expect(runGuard(true)).resolves.toBe(true);
		await expect(runGuard(false)).resolves.toBe(false);
	});
});

describe("middleware page loader", () => {
	const loader = () =>
		middlewarePanelPlugin.panel!.pages![0]!.loader!() as Effect.Effect<
			{ stages: unknown; routes: unknown },
			never,
			PluginStates
		>;

	// stages() declares PluginStates in its environment even though the
	// page only reads it through the service — satisfy it with an
	// inert stub; the service-level orElseSucceed guards real failures.
	const states = {
		isEnabled: () => Effect.succeed(true),
		enabledIds: () => Effect.succeed(new Set<string>()),
	} as never;
	const runLoader = (service?: unknown) => {
		let effect = loader().pipe(Effect.provideService(PluginStates, states));
		if (service !== undefined) {
			effect = effect.pipe(Effect.provideService(MiddlewareStages, service as never));
		}
		return Effect.runPromise(effect);
	};

	it("degrades to nulls when the MiddlewareStages service is absent", async () => {
		await expect(runLoader()).resolves.toEqual({
			stages: null,
			routes: null,
		});
	});

	it("returns stage rows and routes from the registry service", async () => {
		const stages = [
			{
				id: "ktb.principal.session",
				pluginId: "app-host",
				origin: "builtin",
				enabled: true,
			},
		];
		const routes = [{ path: "/platform", context: "platform", routeKey: "/platform" }];
		const service = {
			stages: () => Effect.succeed(stages),
			routes: () => Effect.succeed(routes),
		};
		await expect(runLoader(service)).resolves.toEqual({ stages, routes });
	});

	it("degrades each side independently when a registry read fails", async () => {
		const stagesDown = {
			stages: () => Effect.fail(new Error("db down")),
			routes: () => Effect.succeed([{ path: "/x", context: "app", routeKey: "/x" }]),
		};
		const out = await runLoader(stagesDown);
		expect(out.stages).toBeNull();
		expect(out.routes).toHaveLength(1);

		const routesDown = {
			stages: () => Effect.succeed([]),
			routes: () => Effect.fail(new Error("routes down")),
		};
		const out2 = await runLoader(routesDown);
		expect(out2.stages).toEqual([]);
		expect(out2.routes).toBeNull();
	});
});
