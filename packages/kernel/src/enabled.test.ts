import { describe, expect, it } from "vitest";

import { entryEnabled, packageLive } from "./enabled.ts";

describe("packageLive", () => {
	// Membership resolves through the stamped `pkg`, NOT the id —
	// "session.menu" belongs to package "auth" even though its id
	// shares no prefix with it.
	const plugins = [
		{ id: "auth.routes", pkg: "auth" },
		{ id: "session.menu", pkg: "auth" },
		{ id: "patients.services", pkg: "patients" },
		{ id: "platform.routes" }, // out-of-glob plugin: no pkg stamp
	];

	it("is live while any member plugin id of the package is enabled", () => {
		expect(packageLive(plugins, new Set(["session.menu"]), "auth")).toBe(true);
		expect(packageLive(plugins, new Set(["patients.services"]), "patients")).toBe(true);
	});

	it("is dead when every member id is disabled or belongs elsewhere", () => {
		expect(packageLive(plugins, new Set(["patients.services"]), "auth")).toBe(false);
		expect(packageLive(plugins, new Set(), "auth")).toBe(false);
		// A pkg no plugin claims is dead — fail closed.
		expect(packageLive(plugins, new Set(["auth.routes"]), "ghost")).toBe(false);
	});
});

describe("entryEnabled", () => {
	const plugins = [
		{ id: "patients.routes", pkg: "patients" },
		{ id: "patients.services", pkg: "patients" },
		{ id: "platform.routes" },
	];

	it("gates package-granular when the entry carries a pkg stamp", () => {
		const entry = { pluginId: "patients.routes", pkg: "patients" };
		// The owning id itself is off, but a package sibling stays on.
		expect(entryEnabled(plugins, new Set(["patients.services"]), entry)).toBe(true);
		expect(entryEnabled(plugins, new Set(), entry)).toBe(false);
	});

	it("falls back to the per-id check without a pkg stamp", () => {
		expect(
			entryEnabled(plugins, new Set(["platform.routes"]), { pluginId: "platform.routes" }),
		).toBe(true);
		expect(entryEnabled(plugins, new Set(), { pluginId: "platform.routes", pkg: undefined })).toBe(
			false,
		);
	});
});
