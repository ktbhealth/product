import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("invites client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("carries ids only — no tables, services or routes reach the browser", () => {
		for (const plugin of plugins) expect(Object.keys(plugin)).toEqual(["id"]);
	});
});
