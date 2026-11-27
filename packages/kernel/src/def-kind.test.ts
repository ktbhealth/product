import { describe, expect, it } from "vitest";

import type { PluginContribution } from "./core.ts";
import type { Plugin } from "./contributions.ts";
import { defineDefKind } from "./def-kind.ts";

interface TestDef {
	readonly id: string;
	readonly owner?: string;
	readonly value?: number;
}

const assertTestDef = (value: unknown, context: string): TestDef => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${context}: test def must be an object`);
	}
	const def = value as TestDef;
	if (typeof def.id !== "string" || def.id === "") {
		throw new Error(`${context}: test def id must be a non-empty string`);
	}
	return def;
};

const make = () =>
	defineDefKind<TestDef, "defs">({
		id: "test.def",
		consumers: ["app-host.server", "plugin-manager"],
		assert: assertTestDef,
		defId: (def) => def.id,
		noun: "test def",
		field: "defs",
		uniqueKey: (def) => def.id,
	});

const contributor = (id: string, defs: readonly TestDef[]): Plugin =>
	({
		id,
		contributions: defs.map((def) => ({
			kind: "test.def",
			id: def.id,
			version: "1",
			meta: def,
		})),
	}) as unknown as Plugin;

describe("defineDefKind", () => {
	it("builds a generic-slot topo-ordered kind descriptor", () => {
		const kind = make();
		expect(kind.KIND).toEqual({
			id: "test.def",
			slot: "contributions",
			consumers: ["app-host.server", "plugin-manager"],
			ordering: "topo",
		});
	});

	it('define asserts with the <noun> "<id>" context', () => {
		const kind = make();
		expect(kind.define({ id: "ok", value: 1 })).toEqual({ id: "ok", value: 1 });
		expect(() => kind.define({ id: "" })).toThrowError(
			'test def "": test def id must be a non-empty string',
		);
	});

	it("contribution emits kind/id/version/meta", () => {
		const kind = make();
		const def: TestDef = { id: "d1", value: 2 };
		expect(kind.contribution(def)).toEqual({
			kind: "test.def",
			id: "d1",
			version: "1",
			meta: def,
		});
	});

	it("contribution omits version when the spec returns undefined", () => {
		const kind = defineDefKind<TestDef, "defs">({
			id: "test.def",
			consumers: [],
			assert: assertTestDef,
			defId: (def) => def.id,
			noun: "test def",
			field: "defs",
			version: () => undefined,
		});
		expect(kind.contribution({ id: "d1" })).toEqual({
			kind: "test.def",
			id: "d1",
			meta: { id: "d1" },
		});
	});

	it("contributionId overrides the manifest id", () => {
		const kind = defineDefKind<TestDef, "defs">({
			id: "test.def",
			consumers: [],
			assert: assertTestDef,
			defId: (def) => def.id,
			noun: "test def",
			field: "defs",
			contributionId: (def) => `key-${def.id}`,
		});
		expect(kind.contribution({ id: "d1" }).id).toBe("key-d1");
	});

	it("toDef re-asserts meta and stamps owner from the plugin id", () => {
		const kind = make();
		const entry: PluginContribution = { kind: "test.def", id: "e1", meta: { id: "inner" } };
		expect(kind.toDef(entry, "plugin.a")).toEqual({ id: "inner", owner: "plugin.a" });
		// An explicit owner wins over the plugin stamp.
		const owned: PluginContribution = {
			kind: "test.def",
			id: "e2",
			meta: { id: "inner", owner: "declared" },
		};
		expect(kind.toDef(owned, "plugin.a")).toEqual({ id: "inner", owner: "declared" });
		// Malformed meta throws with the contribution context.
		const malformed = { kind: "test.def", id: "bad", meta: 42 } as unknown as PluginContribution;
		expect(() => kind.toDef(malformed, "plugin.a")).toThrowError(
			'plugin "plugin.a" contribution "bad": test def must be an object',
		);
	});

	it("collect gathers defs in plugin order and stamps owners", () => {
		const kind = make();
		const plugins = [
			contributor("p1", [{ id: "a" }, { id: "b" }]),
			contributor("p2", [{ id: "c", owner: "kept" }]),
		];
		expect(kind.collect(plugins)).toEqual([
			{ id: "a", owner: "p1" },
			{ id: "b", owner: "p1" },
			{ id: "c", owner: "kept" },
		]);
	});

	it("collect throws on duplicate unique keys", () => {
		const kind = make();
		const plugins = [contributor("p1", [{ id: "dup" }]), contributor("p2", [{ id: "dup" }])];
		expect(() => kind.collect(plugins)).toThrowError(
			'duplicate test def id "dup" contributed by multiple plugins',
		);
	});

	it("collect honors uniqueLabel and skips the check when uniqueKey is absent", () => {
		const labeled = defineDefKind<TestDef, "defs">({
			id: "test.def",
			consumers: [],
			assert: assertTestDef,
			defId: (def) => def.id,
			noun: "test def",
			field: "defs",
			uniqueKey: (def) => def.id,
			uniqueLabel: "test key",
		});
		const plugins = [contributor("p1", [{ id: "dup" }]), contributor("p2", [{ id: "dup" }])];
		expect(() => labeled.collect(plugins)).toThrowError(
			'duplicate test key "dup" contributed by multiple plugins',
		);

		const unchecked = defineDefKind<TestDef, "defs">({
			id: "test.def",
			consumers: [],
			assert: assertTestDef,
			defId: (def) => def.id,
			noun: "test def",
			field: "defs",
		});
		expect(unchecked.collect(plugins)).toHaveLength(2);
	});

	it("makeRegistry returns the defs under the field key plus the owner index", () => {
		const kind = make();
		const plugins = [
			{ id: "p1", pkg: "pkg-a", contributions: [] },
			contributor("p2", [{ id: "a" }]),
		] as unknown as Plugin[];
		const registry = kind.makeRegistry(plugins);
		expect(registry.defs).toEqual([{ id: "a", owner: "p2" }]);
		expect(registry.ownerIndex.pkgById.get("p1")).toBe("pkg-a");
		expect(registry.ownerIndex.membersByPkg.get("pkg-a")).toEqual(["p1"]);
	});
});
