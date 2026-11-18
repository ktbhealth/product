import { describe, expect, it } from "vitest";

import { plugins, triggersServicesPlugin } from "./index.ts";

describe("triggers plugin manifest", () => {
	it("exports the single-concern services plugin", () => {
		expect(plugins).toEqual([triggersServicesPlugin]);
		expect(triggersServicesPlugin.id).toBe("triggers.services");
		expect(triggersServicesPlugin.meta?.keywords).toEqual(["triggers", "services"]);
		expect(triggersServicesPlugin.requiredDeps).toEqual(["document-store.services"]);
		expect(triggersServicesPlugin.services).toBeDefined();
	});
});
