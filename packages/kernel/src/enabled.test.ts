import { describe, expect, it } from "vitest";

import type { Plugin } from "./contributions.ts";
import { buildDefOwnerIndex, defOwnerEnabled, entryEnabled, packageLive } from "./enabled.ts";

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

describe("buildDefOwnerIndex / defOwnerEnabled", () => {
	// Hand-built plugin rows — the index only reads id/pkg.
	const plugins = [
		{ id: "pkg.x.main", pkg: "pkg.x" },
		{ id: "pkg.x.extra", pkg: "pkg.x" },
		{ id: "solo.plugin" },
	] as unknown as Plugin[];
	const index = buildDefOwnerIndex(plugins);

	it("is package-granular: any enabled member keeps pkg-stamped owners live", () => {
		expect(defOwnerEnabled(index, "pkg.x.main", new Set(["pkg.x.extra"]))).toBe(true);
		expect(defOwnerEnabled(index, "pkg.x.main", new Set(["solo.plugin"]))).toBe(false);
		expect(defOwnerEnabled(index, "pkg.x.main", new Set())).toBe(false);
	});

	it("falls back to per-id for unstamped owners", () => {
		expect(defOwnerEnabled(index, "solo.plugin", new Set(["solo.plugin"]))).toBe(true);
		expect(defOwnerEnabled(index, "solo.plugin", new Set())).toBe(false);
	});

	it("tolerates an index missing the pkg member list — falls back to the owner id", () => {
		// A hand-built index can stamp pkgById without membersByPkg;
		// defOwnerEnabled must still answer per-id instead of crashing.
		const broken = {
			pkgById: new Map([["x.main", "x.pkg"]]),
			membersByPkg: new Map<string, readonly string[]>(),
		};
		expect(defOwnerEnabled(broken, "x.main", new Set(["x.main"]))).toBe(true);
		expect(defOwnerEnabled(broken, "x.main", new Set())).toBe(false);
	});

	it("unattributed or unindexed defs stay live", () => {
		expect(defOwnerEnabled(index, undefined, new Set())).toBe(true);
		expect(defOwnerEnabled(undefined, "pkg.x.main", new Set())).toBe(false);
		expect(defOwnerEnabled(undefined, "pkg.x.main", new Set(["pkg.x.main"]))).toBe(true);
	});
});
