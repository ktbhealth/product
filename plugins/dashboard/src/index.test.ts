import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LayoutDashboardIcon } from "lucide-react";

import { platformPanelPlugin } from "@ktb/platform";
import { PluginStates } from "@ktb/platform/plugin-states";
import type { Plugin } from "@ktb/kernel";

import { dashboardChromePlugin, dashboardPanelPlugin, plugins } from "./index.ts";

describe("dashboard plugins", () => {
	it("declares the Overview-grouped /platform sidebar chrome entry", () => {
		expect(dashboardChromePlugin.id).toBe("dashboard.chrome");
		expect(dashboardChromePlugin.requiredDeps).toEqual([platformPanelPlugin.id]);
		expect(dashboardChromePlugin.chrome).toEqual([
			{
				id: "dashboard.sidebar",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: {
						to: "/platform",
						label: "Dashboard",
						icon: LayoutDashboardIcon,
						exact: true,
						group: "Overview",
					},
				},
			},
		]);
	});

	it("declares the /platform page descriptor", () => {
		expect(dashboardPanelPlugin.id).toBe("dashboard.panel");
		expect(dashboardPanelPlugin.requiredDeps).toEqual([platformPanelPlugin.id]);
		// T-125: the dashboard is a generic shell — no domain-service dep
		// edges; domain plugins extend it via portal.dashboard.* chrome.
		expect(dashboardPanelPlugin).not.toHaveProperty("optionalDeps");
		expect(dashboardPanelPlugin.panel?.pages?.[0]?.path).toBe("/platform");
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual(["dashboard.chrome", "dashboard.panel"]);
		const p: Plugin = dashboardPanelPlugin;
		expect("panel" in p && p.panel.pages?.[0]?.path).toBe("/platform");
	});
});

type Loader = () => Effect.Effect<unknown, never, PluginStates>;

const loader = (): Loader => {
	const page = dashboardPanelPlugin.panel?.pages?.[0];
	if (!page || !("loader" in page) || !page.loader) throw new Error("dashboard page has no loader");
	return page.loader as unknown as Loader;
};

const pluginStatesLive = Layer.succeed(PluginStates, {
	entries: () => Effect.succeed([{ pluginId: "a.b", enabled: true, system: false, config: null }]),
} as never);

const runLoader = (opts: { pluginStates?: boolean }) => {
	const layer =
		opts.pluginStates === false
			? (Layer.empty as unknown as Layer.Layer<unknown, never, unknown>)
			: (pluginStatesLive as Layer.Layer<unknown, never, unknown>);
	return Effect.runPromise(loader()().pipe(Effect.provide(layer)) as Effect.Effect<unknown>);
};

describe("dashboard loader", () => {
	it("returns only plugin states — domain feeds moved to chrome slots (T-125)", async () => {
		await expect(runLoader({})).resolves.toEqual({
			pluginStates: [{ pluginId: "a.b", enabled: true, system: false, config: null }],
		});
	});

	it("omits plugin states when the service is absent", async () => {
		await expect(runLoader({ pluginStates: false })).resolves.toEqual({
			pluginStates: undefined,
		});
	});
});
