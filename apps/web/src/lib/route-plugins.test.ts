import { describe, expect, it } from "vitest";

import { plugins as serverPlugins } from "@ktb/app-host";

import { routePluginEntries, routePlugins } from "./route-plugins.ts";

/**
 * Drift guard for src/routes.ts composition: the route tree is built from
 * the static imports in route-plugins.ts because jiti (typegen) cannot run
 * @ktb/app-host's import.meta.glob discovery. A plugin that adds `routes`
 * to its manifest but whose package is missing from that list would mount
 * nothing — silently. This test fails loudly instead, keyed on plugin id
 * (pkg stamps are plugins/<dir> names, not package specifiers, and
 * @ktb/platform's out-of-glob plugins are unstamped).
 */
describe("route plugin composition", () => {
	const coveredIds = new Set(routePlugins.map((p) => p.id));
	const serverIds = new Set(serverPlugins.map((p) => p.id));

	it("covers every route-bearing plugin in the server registry", () => {
		const missing = serverPlugins
			.filter((p) => (p.routes?.length ?? 0) > 0 && !coveredIds.has(p.id))
			.map((p) => `${p.id} (pkg: ${p.pkg ?? "unstamped"})`);
		expect(
			missing,
			`route-bearing plugins missing from lib/route-plugins.ts — add a static \`plugins\` import + routePluginEntries row for each`,
		).toEqual([]);
	});

	it("only references plugins the server registry knows", () => {
		const unknown = routePlugins.filter((p) => !serverIds.has(p.id)).map((p) => p.id);
		expect(unknown, "routePlugins entries not present in @ktb/app-host serverPlugins").toEqual([]);
	});

	it("has no duplicate plugin ids across entries", () => {
		const seen = new Set<string>();
		const dupes: string[] = [];
		for (const p of routePlugins) {
			if (seen.has(p.id)) dupes.push(p.id);
			seen.add(p.id);
		}
		expect(dupes).toEqual([]);
	});

	it("keeps one entry per imported package", () => {
		const pkgs = routePluginEntries.map((e) => e.pkg);
		expect(new Set(pkgs).size).toBe(pkgs.length);
	});
});
