import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("dev-capture-test client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("carries no server-only page handlers", () => {
		for (const page of plugins[0]?.pages ?? []) {
			expect(page.loader).toBeUndefined();
			expect(page.guard).toBeUndefined();
		}
	});
});
