import { describe, expect, it } from "vitest";

import { plugins, flowsServicesPlugin } from "./index.ts";

describe("flows plugin manifest", () => {
	it("exports the single-concern services plugin", () => {
		expect(plugins).toEqual([flowsServicesPlugin]);
		expect(flowsServicesPlugin.id).toBe("flows.services");
		expect(flowsServicesPlugin.meta?.keywords).toEqual(["flows", "services"]);
		expect(flowsServicesPlugin.requiredDeps).toEqual(["document-store.services"]);
		expect(flowsServicesPlugin.optionalDeps).toEqual(["rbac.services"]);
		expect(flowsServicesPlugin.services).toBeDefined();
	});
});
