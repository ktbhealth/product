import { describe, expect, it } from "vitest";

import { portalShellPlugin, portalServicesPlugin, plugins } from "./index.ts";

describe("portal plugins", () => {
	it("exposes the services and shell-anchor entries", () => {
		expect(plugins).toEqual([portalServicesPlugin, portalShellPlugin]);
	});

	it("marks both entries system so they can never be disabled", () => {
		for (const p of plugins) expect(p.system).toBe(true);
	});

	it("orders the shell anchor after the services entry", () => {
		expect(portalShellPlugin.requiredDeps).toEqual([portalServicesPlugin.id]);
	});
});
