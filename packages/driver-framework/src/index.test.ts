import { describe, expect, it } from "vitest";

import type { Plugin } from "@ktb/kernel";
import { discoverPlugins, orderPlugins } from "./index.ts";

// Dep ids are checked against PluginRegistry at compile time; the test
// program declares the ids it uses so the fixtures typecheck.
declare module "@ktb/kernel" {
	interface PluginRegistry {
		a: true;
		b: true;
		c: true;
		d: true;
		ghost: true;
	}
}

const p = (
	id: string,
	requiredDeps?: Plugin["requiredDeps"],
	optionalDeps?: Plugin["optionalDeps"],
): Plugin => ({ id, requiredDeps, optionalDeps });

describe("discoverPlugins", () => {
	it("collects every plugin in each module's plugins export", () => {
		const plugins = discoverPlugins({
			"./patients.ts": { plugins: [p("patients.tables"), p("patients.services")] },
			"./consultations.ts": { plugins: [p("consultations.services")] },
			"./empty.ts": { plugins: [] },
		});
		expect(plugins.map((x) => x.id)).toEqual([
			"patients.tables",
			"patients.services",
			"consultations.services",
		]);
	});

	it("stamps pkg from plugins/<pkg>/src/… module paths, leaves other keys unstamped", () => {
		const plugins = discoverPlugins({
			"../../../plugins/patients/src/index.ts": { plugins: [p("patients.services")] },
			"../../../plugins/auth/src/client.ts": { plugins: [p("session.menu")] },
			"@ktb/platform": { plugins: [p("platform.routes")] },
			"./local.ts": { plugins: [p("local.plugin")] },
			"plugins/standalone/src/index.ts": { plugins: [p("standalone.plugin")] },
		});
		expect(plugins.map((x) => [x.id, x.pkg])).toEqual([
			["patients.services", "patients"],
			["session.menu", "auth"],
			["platform.routes", undefined],
			["local.plugin", undefined],
			["standalone.plugin", "standalone"],
		]);
		expect(plugins[2]).not.toHaveProperty("pkg");
		expect(plugins[3]).not.toHaveProperty("pkg");
	});

	it("throws when a module does not export a plugins array", () => {
		expect(() => discoverPlugins({ "./broken.ts": { plugin: p("x") } })).toThrow(
			'plugin module "./broken.ts" must export `plugins` as a Plugin array',
		);
		expect(() => discoverPlugins({ "./null.ts": null })).toThrow(
			'plugin module "./null.ts" must export `plugins` as a Plugin array',
		);
		expect(() => discoverPlugins({ "./scalar.ts": { plugins: "nope" } })).toThrow(
			'plugin module "./scalar.ts" must export `plugins` as a Plugin array',
		);
	});

	it("throws when the plugins array contains a non-plugin value", () => {
		expect(() => discoverPlugins({ "./mixed.ts": { plugins: [p("ok"), { noId: true }] } })).toThrow(
			'plugin module "./mixed.ts" exports a value that is not a Plugin',
		);
	});

	it("rejects null and function plugin values even when they carry an id", () => {
		expect(() => discoverPlugins({ "./null-plugin.ts": { plugins: [null] } })).toThrow(
			'plugin module "./null-plugin.ts" exports a value that is not a Plugin',
		);
		const fn = Object.assign(() => {}, { id: "fn.plugin" });
		expect(() => discoverPlugins({ "./fn.ts": { plugins: [fn] } })).toThrow(
			'plugin module "./fn.ts" exports a value that is not a Plugin',
		);
	});

	it("rejects module values that are not objects even if they carry plugins", () => {
		const fn = Object.assign(() => {}, { plugins: [p("fn.plugin")] });
		expect(() => discoverPlugins({ "./fn-module.ts": fn })).toThrow(
			'plugin module "./fn-module.ts" must export `plugins` as a Plugin array',
		);
	});
});

describe("orderPlugins", () => {
	it("topologically sorts by requiredDeps", () => {
		const ordered = orderPlugins([p("c", ["b"]), p("a"), p("b", ["a"])]);
		expect(ordered.map((x) => x.id)).toEqual(["a", "b", "c"]);
	});

	it("orders by optionalDeps when the dep is present", () => {
		const ordered = orderPlugins([p("a", undefined, ["b"]), p("b")]);
		expect(ordered.map((x) => x.id)).toEqual(["b", "a"]);
	});

	it("ignores optionalDeps that resolve to no plugin", () => {
		const ordered = orderPlugins([p("a", undefined, ["ghost"]), p("b")]);
		expect(ordered.map((x) => x.id)).toContain("a");
	});

	it("does not treat a missing optionalDeps as a dep on every registered id", () => {
		const ordered = orderPlugins([p("a"), p("Stryker was here", undefined, [])]);
		expect(ordered.map((x) => x.id)).toEqual(["a", "Stryker was here"]);
	});

	it("throws on unknown requiredDep", () => {
		expect(() => orderPlugins([p("a", ["ghost"])])).toThrow(
			'plugin "a" requires unknown plugin "ghost"',
		);
	});

	it("throws on duplicate plugin id", () => {
		expect(() => orderPlugins([p("a"), p("a")])).toThrow('duplicate plugin id "a"');
	});

	it("throws on dependency cycle", () => {
		expect(() => orderPlugins([p("a", ["b"]), p("b", ["a"])])).toThrow(
			"Cannot perform topological sort on cyclic graph",
		);
	});
});
