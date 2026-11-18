import { describe, expect, it } from "vitest";

import { apiServicesPlugin, apiRoutesPlugin, plugins } from "./index.ts";

describe("api plugins", () => {
	it("exports the two single-concern plugins in order", () => {
		expect(plugins).toEqual([apiServicesPlugin, apiRoutesPlugin]);
		expect(plugins.map((p) => p.id)).toEqual(["api.services", "api.routes"]);
	});

	it("declares the expected dependency edges", () => {
		expect(apiServicesPlugin.requiredDeps).toEqual(["document-store.services"]);
		expect(apiRoutesPlugin.requiredDeps).toEqual(["api.services"]);
	});

	it("mounts the api-routes directory under /api via physical()", () => {
		const routes = apiRoutesPlugin.routes;
		expect(routes).toHaveLength(1);
		// physical() nodes carry the scan path — assert the shape loosely.
		expect(JSON.stringify(routes[0])).toContain("api-routes");
	});

	it("carries the api keyword on both manifests", () => {
		expect(apiServicesPlugin.meta?.keywords).toContain("api");
		expect(apiRoutesPlugin.meta?.keywords).toContain("api");
	});
});
