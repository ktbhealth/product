import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("views client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("carries only client-consumed contributions", () => {
		const page = plugins.find((p) => p.id === "views.pages");
		expect(page?.pages?.[0]?.path).toBe("/v/*");
		expect(page?.pages?.[0]?.loader).toBeUndefined();
		expect(page?.pages?.[0]?.guard).toBeUndefined();
		for (const p of plugins) {
			expect(p.services).toBeUndefined();
		}
	});
});
