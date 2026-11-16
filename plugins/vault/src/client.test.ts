import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("vault client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("carries no server-only contributions", () => {
		for (const p of plugins) {
			expect(p.tables).toBeUndefined();
			expect(p.services).toBeUndefined();
			for (const page of p.pages ?? []) {
				expect(page.loader).toBeUndefined();
				expect(page.guard).toBeUndefined();
			}
		}
	});
});
