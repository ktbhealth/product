import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("wizards client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("carries only client-consumed contributions", () => {
		const client = plugins.find((p) => p.id === "wizards.render");
		expect(client?.pages?.[0]?.path).toBe("/wizards/*");
		expect(client?.pages?.[0]?.loader).toBeUndefined();
		const chrome = plugins.find((p) => p.id === "wizards.chrome");
		expect(chrome?.chrome?.[0]?.id).toBe("wizards.sidebar");
		const panel = plugins.find((p) => p.id === "wizards.panel");
		expect(panel?.panel?.pages?.[0]?.path).toBe("/platform/wizards");
		// server-only slices stay out of the client registry
		for (const p of plugins) {
			expect(p.tables).toBeUndefined();
			expect(p.services).toBeUndefined();
		}
	});
});
