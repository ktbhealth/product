import { describe, expect, it } from "vitest";

import { plugins } from "./client.ts";
import { plugins as serverPlugins } from "./index.ts";

describe("theme client plugins", () => {
	it("mirrors the server plugin ids", () => {
		expect(plugins.map((p) => p.id)).toEqual(serverPlugins.map((p) => p.id));
	});

	it("declares the client-safe contributions", () => {
		const byId = Object.fromEntries(plugins.map((p) => [p.id, p]));
		expect(byId["theme.services"]?.requiredDeps).toEqual(["platform.admin"]);
		expect(byId["theme.panel"]?.panel?.pages?.[0]).toMatchObject({
			id: "theme.admin",
			path: "/platform/theme",
		});
		expect(byId["theme.routes"]).toBeDefined();
	});
});
