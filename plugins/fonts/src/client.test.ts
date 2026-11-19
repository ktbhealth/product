import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("fonts client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("declares the client-safe contributions", () => {
		const byId = Object.fromEntries(plugins.map((p) => [p.id, p]));
		expect(byId["fonts.services"]?.requiredDeps).toEqual(["platform.admin"]);
		expect(byId["fonts.panel"]?.panel?.pages?.map((p) => p.path)).toEqual([
			"/platform/fonts/providers",
			"/platform/fonts",
		]);
		expect(byId["fonts.chrome"]?.chrome).toHaveLength(2);
		for (const p of plugins) {
			expect(p.services).toBeUndefined();
			for (const page of p.panel?.pages ?? []) {
				expect(page.loader).toBeUndefined();
				expect(page.guard).toBeUndefined();
			}
		}
	});
});
